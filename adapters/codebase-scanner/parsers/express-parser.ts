/**
 * Express parser — 偵測並解析 Express/Router 風格的路由宣告
 *
 * 策略（跨檔案兩步驟）：
 * 1. detect()：讀 package.json，確認有 `express` dependency
 * 2. parse() 第一步：掃所有檔案，收集全域 app.use(prefix, routerVar) mount 表
 * 3. parse() 第二步：掃所有檔案，依 mount 表解析 routerVar.METHOD(path)
 *    - app 直接宣告的 app.METHOD() → 直接記錄
 *    - 巢狀超過一層 → console.warn 跳過
 *
 * 限制（v1）：
 * - prefix 必須為字串字面量（動態 prefix 不支援）
 * - 巢狀 router 超過 depth=1 → warn + skip
 *
 * Wave 7 重構：
 * - 把單檔的「mount edges + method calls」一次萃取為 raw 中間表示，走 mtime cache
 * - 同一檔未變動時跳過 readFile + babel parse + AST traverse
 * - buildGlobalMountTable / 第二步 endpoints 萃取改成從 raw 中間表示組合
 */

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import { parse as babelParse } from '@babel/parser';
import fg from 'fast-glob';
import type { ApiEndpoint, HttpMethod } from '../types.ts';
import type { FrameworkParser } from '../registry.ts';
import { registerParser } from '../registry.ts';
import { maybeCachedParse } from '../cache.ts';

// @babel/traverse 是 CJS 模組，使用 createRequire 確保正確載入
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const traverseModule = require('@babel/traverse') as any;

type AstPath = { node: { expression: unknown } };
type Visitor = Record<string, (path: AstPath) => void>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
const traverse = (traverseModule.default ?? traverseModule) as (
  ast: ReturnType<typeof babelParse>,
  visitor: Visitor,
) => void;

// ─── 常數 ────────────────────────────────────────────────────────────────────

const HTTP_METHODS: Record<string, HttpMethod> = {
  get: 'GET',
  post: 'POST',
  put: 'PUT',
  delete: 'DELETE',
  patch: 'PATCH',
};

/** Wave 7：cache namespace（隔離不同 parser 的快取結果） */
const CACHE_NAMESPACE = 'express-raw';

// ─── 型別工具 ─────────────────────────────────────────────────────────────────

function isCallExpr(node: unknown): node is {
  type: 'CallExpression';
  callee: unknown;
  arguments: unknown[];
  loc?: { start: { line: number } };
} {
  return (node as { type?: string } | null)?.type === 'CallExpression';
}

function isMemberExpr(node: unknown): node is {
  type: 'MemberExpression';
  object: unknown;
  property: unknown;
} {
  return (node as { type?: string } | null)?.type === 'MemberExpression';
}

function isIdentifier(node: unknown, name?: string): node is {
  type: 'Identifier';
  name: string;
} {
  if ((node as { type?: string } | null)?.type !== 'Identifier') return false;
  if (name !== undefined) return (node as { name?: string }).name === name;
  return true;
}

function isStringLiteral(node: unknown): node is {
  type: 'StringLiteral';
  value: string;
} {
  return (node as { type?: string } | null)?.type === 'StringLiteral';
}

function getLine(expr: unknown): number {
  return (
    (expr as { loc?: { start?: { line?: number } } } | undefined)?.loc?.start?.line ?? 0
  );
}

// ─── 型別 ────────────────────────────────────────────────────────────────────

/** 全域 mount 關係：某個 varName 被 use 在哪些 prefix 下 */
interface MountInfo {
  prefixes: string[];
  /** 是否是深度 >1 的巢狀（需要 warn） */
  isNested: boolean;
}

/** Per-file 的單筆 mount edge（app.use(prefix, routerVar)） */
interface RawEdge {
  callerName: string;
  varName: string;
  prefix: string;
  line: number;
}

/** Per-file 的單筆 method call（router.get('/path', ...)） */
interface RawMethodCall {
  method: HttpMethod;
  routePath: string;
  callerName: string;
  line: number;
}

/**
 * 單檔走完 AST 後的 raw 中間表示。
 * 這是 cache payload——同檔 mtime 一致就直接重用，跳過 babel parse。
 */
interface RawFilePayload {
  edges: RawEdge[];
  methodCalls: RawMethodCall[];
}

// ─── 輔助：解析單一檔案 AST 並萃取 raw 中間表示 ──────────────────────────────

/**
 * Cache miss 時實際跑的解析邏輯：讀檔 + babel parse + AST traverse。
 * 萃取兩種 raw 中間表示供後續組合（mount table、endpoints）。
 *
 * 失敗時回傳空 payload，不拋錯。
 */
async function parseFileToRawImpl(filePath: string): Promise<RawFilePayload> {
  let source: string;
  try {
    source = await readFile(filePath, 'utf-8');
  } catch {
    return { edges: [], methodCalls: [] };
  }

  let ast: ReturnType<typeof babelParse>;
  try {
    ast = babelParse(source, {
      sourceType: 'module',
      plugins: ['typescript', 'decorators'],
      errorRecovery: true,
    });
  } catch {
    return { edges: [], methodCalls: [] };
  }

  const edges: RawEdge[] = [];
  const methodCalls: RawMethodCall[] = [];

  traverse(ast, {
    ExpressionStatement(nodePath) {
      const expr = nodePath.node.expression;
      if (!isCallExpr(expr)) return;
      if (!isMemberExpr(expr.callee)) return;

      const objectNode = expr.callee.object;
      const propertyNode = expr.callee.property;
      if (!isIdentifier(objectNode)) return;
      if (!isIdentifier(propertyNode)) return;

      const callerName = objectNode.name;
      const propName = propertyNode.name;

      // ── 收集 mount edges：*.use(prefix, routerVar)
      if (propName === 'use') {
        const args = expr.arguments;
        if (args.length >= 2) {
          const prefixArg = args[0];
          const routerArg = args[1];
          if (isStringLiteral(prefixArg) && isIdentifier(routerArg)) {
            edges.push({
              callerName,
              varName: routerArg.name,
              prefix: prefixArg.value,
              line: getLine(expr),
            });
          }
        }
        return;
      }

      // ── 收集 method calls：*.METHOD(path, ...)
      const lower = propName.toLowerCase();
      if (lower in HTTP_METHODS) {
        const args = expr.arguments;
        if (args.length >= 1) {
          const pathArg = args[0];
          if (isStringLiteral(pathArg)) {
            methodCalls.push({
              method: HTTP_METHODS[lower] as HttpMethod,
              routePath: pathArg.value,
              callerName,
              line: getLine(expr),
            });
          }
        }
      }
    },
  });

  return { edges, methodCalls };
}

/**
 * Cache-aware wrapper：包 parseFileToRawImpl，命中時直接回 cached payload。
 */
async function parseFileToRaw(filePath: string): Promise<RawFilePayload> {
  return maybeCachedParse<RawFilePayload>(
    filePath,
    CACHE_NAMESPACE,
    () => parseFileToRawImpl(filePath),
  );
}

// ─── Step 1：跨檔案收集 mount 表 ──────────────────────────────────────────────

/**
 * 給定每檔 raw payload，建立全域 mount 表。
 * 純函式，不做 IO。
 */
function buildMountTableFromPayloads(
  payloads: ReadonlyArray<{ filePath: string; payload: RawFilePayload }>,
): Map<string, MountInfo> {
  // 收集所有 raw edges
  const allEdges: RawEdge[] = [];
  for (const { payload } of payloads) {
    for (const edge of payload.edges) {
      allEdges.push(edge);
    }
  }

  // 找出所有「被掛載為 router」的變數名稱集合
  const allMountedVarNames = new Set(allEdges.map((e) => e.varName));

  // 建立 MountInfo：
  // - depth-1：callerName 不在 allMountedVarNames 中
  // - 巢狀：callerName 在 allMountedVarNames 中
  const mountTable = new Map<string, MountInfo>();

  for (const edge of allEdges) {
    const isNested = allMountedVarNames.has(edge.callerName);

    if (!isNested) {
      const existing = mountTable.get(edge.varName);
      if (existing) {
        existing.prefixes.push(edge.prefix);
      } else {
        mountTable.set(edge.varName, { prefixes: [edge.prefix], isNested: false });
      }
    } else {
      const existing = mountTable.get(edge.varName);
      if (existing) {
        existing.isNested = true;
      } else {
        mountTable.set(edge.varName, { prefixes: [edge.prefix], isNested: true });
      }
    }
  }

  return mountTable;
}

// ─── Step 2：根據 mount 表 + raw method calls 組 endpoints ─────────────────

/**
 * 純函式：給定單檔 raw method calls + 全域 mount 表，吐 ApiEndpoint。
 */
function endpointsFromMethodCalls(
  methodCalls: ReadonlyArray<RawMethodCall>,
  relFile: string,
  mountTable: Map<string, MountInfo>,
): ApiEndpoint[] {
  const endpoints: ApiEndpoint[] = [];
  const warnedNested = new Set<string>(); // 避免同一位置重複 warn

  for (const call of methodCalls) {
    const { method, routePath, callerName, line } = call;
    const mountInfo = mountTable.get(callerName);

    if (mountInfo !== undefined) {
      if (mountInfo.isNested) {
        const warnKey = `${relFile}:${line}`;
        if (!warnedNested.has(warnKey)) {
          warnedNested.add(warnKey);
          console.warn(
            `nested router beyond depth 1 skipped at ${relFile}:${line}`,
          );
        }
        continue;
      }

      // depth-1 router → 組合完整路徑
      for (const prefix of mountInfo.prefixes) {
        const combined = (
          prefix.replace(/\/+$/, '') +
          '/' +
          routePath.replace(/^\/+/, '')
        ).replace(/\/$/, '') || '/';
        endpoints.push({
          method,
          path: combined,
          source: { file: relFile, line },
          framework: 'express',
        });
      }
    } else if (callerName === 'app' || callerName.endsWith('App')) {
      // 頂層 app.METHOD() 直接宣告
      endpoints.push({
        method,
        path: routePath,
        source: { file: relFile, line },
        framework: 'express',
      });
    }
  }

  return endpoints;
}

// ─── FrameworkParser 實作 ─────────────────────────────────────────────────────

const expressParser: FrameworkParser = {
  framework: 'express',

  /**
   * 偵測方式：讀根目錄 package.json，確認 dependencies 中含 'express'。
   * Monorepo：也嘗試 apps/{subdir}/package.json。
   */
  async detect(rootDir: string): Promise<boolean> {
    const rootPkg = await tryReadPackageJson(join(rootDir, 'package.json'));
    if (rootPkg !== null && hasExpressDep(rootPkg)) return true;

    let subPkgs: string[] = [];
    try {
      subPkgs = await fg('apps/*/package.json', { cwd: rootDir, absolute: true });
    } catch {
      return false;
    }

    for (const pkgPath of subPkgs) {
      const pkg = await tryReadPackageJson(pkgPath);
      if (pkg !== null && hasExpressDep(pkg)) return true;
    }

    return false;
  },

  /**
   * 兩步驟解析（Wave 7 重構：單一 AST 走訪萃取兩種 raw 中間表示，跨檔組合）：
   * 1. 平行解析每檔 → raw payload（走 cache）
   * 2. 從 raw payloads 建立全域 mount 表
   * 3. 用 mount 表 + 每檔 method calls 組 endpoints
   */
  async parse(rootDir: string): Promise<ApiEndpoint[]> {
    let files: string[];
    try {
      files = await fg(['**/*.{ts,js,tsx,jsx}'], {
        cwd: rootDir,
        absolute: true,
        ignore: [
          '**/node_modules/**',
          '**/dist/**',
          '**/.next/**',
          '**/build/**',
          '**/*.test.{ts,js}',
          '**/*.spec.{ts,js}',
          '**/__tests__/**',
        ],
      });
    } catch {
      return [];
    }

    // Step 1：每檔走 cache 取 raw payload
    const filePayloads = await Promise.all(
      files.map(async (filePath) => ({
        filePath,
        payload: await parseFileToRaw(filePath),
      })),
    );

    // Step 2：跨檔建立 mount 表
    const mountTable = buildMountTableFromPayloads(filePayloads);

    // Step 3：組 endpoints
    const allEndpoints: ApiEndpoint[] = [];
    for (const { filePath, payload } of filePayloads) {
      const relFile = relative(rootDir, filePath);
      const eps = endpointsFromMethodCalls(payload.methodCalls, relFile, mountTable);
      allEndpoints.push(...eps);
    }

    return allEndpoints;
  },
};

// ─── 輔助函式 ─────────────────────────────────────────────────────────────────

async function tryReadPackageJson(pkgPath: string): Promise<unknown> {
  try {
    const raw = await readFile(pkgPath, 'utf-8');
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function hasExpressDep(pkg: unknown): boolean {
  if (typeof pkg !== 'object' || pkg === null) return false;
  const p = pkg as Record<string, unknown>;
  const deps = {
    ...(p['dependencies'] as Record<string, unknown> ?? {}),
    ...(p['devDependencies'] as Record<string, unknown> ?? {}),
  };
  return 'express' in deps;
}

// ─── 自動註冊 ─────────────────────────────────────────────────────────────────

registerParser(expressParser);

// ─── 匯出（供測試直接使用）─────────────────────────────────────────────────────

export { expressParser };

/**
 * 供測試用：解析單一檔案字串（不跨檔案），用空 mount 表
 *
 * 介面與 v1 相容：仍接收 filePath、rootDir、可選 externalMounts。
 * 內部已切換到 raw payload 路徑。
 */
export async function _parseFileForTesting(
  filePath: string,
  rootDir: string,
  externalMounts?: Map<string, MountInfo>,
): Promise<ApiEndpoint[]> {
  const payload = await parseFileToRawImpl(filePath);
  const relFile = relative(rootDir, filePath);

  // 先建立 mount 表：用外部給的或從本檔自己生
  const mountTable =
    externalMounts !== undefined
      ? externalMounts
      : buildMountTableFromPayloads([{ filePath, payload }]);

  return endpointsFromMethodCalls(payload.methodCalls, relFile, mountTable);
}

// 重新導出 MountInfo 型別供測試使用
export type { MountInfo };
