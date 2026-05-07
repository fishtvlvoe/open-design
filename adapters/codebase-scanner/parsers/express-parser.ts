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
 */

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import { parse as babelParse } from '@babel/parser';
import fg from 'fast-glob';
import type { ApiEndpoint, HttpMethod } from '../types.ts';
import type { FrameworkParser } from '../registry.ts';
import { registerParser } from '../registry.ts';

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

// ─── 輔助：解析單一檔案 AST ──────────────────────────────────────────────────

async function parseAst(
  filePath: string,
): Promise<ReturnType<typeof babelParse> | null> {
  let source: string;
  try {
    source = await readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
  try {
    return babelParse(source, {
      sourceType: 'module',
      plugins: ['typescript', 'decorators'],
      errorRecovery: true,
    });
  } catch {
    return null;
  }
}

// ─── Step 1：跨檔案收集 mount 表 ──────────────────────────────────────────────

/**
 * 掃所有檔案，收集 `*.use(prefix, routerVar)` 關係。
 * 回傳：Map<routerVarName, MountInfo>
 */
async function buildGlobalMountTable(
  files: string[],
): Promise<Map<string, MountInfo>> {
  // 收集所有 raw edges：{ callerName, varName, prefix }
  interface RawEdge {
    callerName: string;
    varName: string;
    prefix: string;
    filePath: string;
    line: number;
  }

  const rawEdges: RawEdge[] = [];

  await Promise.all(
    files.map(async (filePath) => {
      const ast = await parseAst(filePath);
      if (ast === null) return;

      traverse(ast, {
        ExpressionStatement(nodePath) {
          const expr = nodePath.node.expression;
          if (!isCallExpr(expr)) return;
          if (!isMemberExpr(expr.callee)) return;
          if (!isIdentifier(expr.callee.property, 'use')) return;

          const objectNode = expr.callee.object;
          if (!isIdentifier(objectNode)) return;

          const args = expr.arguments;
          if (args.length < 2) return;

          const prefixArg = args[0];
          if (!isStringLiteral(prefixArg)) return;

          const routerArg = args[1];
          if (!isIdentifier(routerArg)) return;

          rawEdges.push({
            callerName: objectNode.name,
            varName: routerArg.name,
            prefix: prefixArg.value,
            filePath,
            line: getLine(expr),
          });
        },
      });
    }),
  );

  // 找出所有「被掛載為 router」的變數名稱集合
  const allMountedVarNames = new Set(rawEdges.map((e) => e.varName));

  // 建立 MountInfo：
  // - depth-1：callerName 不在 allMountedVarNames 中
  // - 巢狀：callerName 在 allMountedVarNames 中
  const mountTable = new Map<string, MountInfo>();

  for (const edge of rawEdges) {
    const isNested = allMountedVarNames.has(edge.callerName);

    if (!isNested) {
      // depth-1 mount
      const existing = mountTable.get(edge.varName);
      if (existing) {
        existing.prefixes.push(edge.prefix);
      } else {
        mountTable.set(edge.varName, { prefixes: [edge.prefix], isNested: false });
      }
    } else {
      // 巢狀 mount → 記錄但標記 isNested
      const existing = mountTable.get(edge.varName);
      if (existing) {
        // 已存在（可能有多個 caller），合併
        existing.isNested = true;
      } else {
        mountTable.set(edge.varName, { prefixes: [edge.prefix], isNested: true });
      }
    }
  }

  return mountTable;
}

// ─── Step 2：根據 mount 表解析 endpoints ──────────────────────────────────────

/**
 * 解析單一檔案中的 routerVar.METHOD(path) 呼叫，使用全域 mount 表。
 */
function extractEndpointsFromAst(
  ast: ReturnType<typeof babelParse>,
  relFile: string,
  mountTable: Map<string, MountInfo>,
): ApiEndpoint[] {
  const endpoints: ApiEndpoint[] = [];
  const warnedNested = new Set<string>(); // 避免同一位置重複 warn

  traverse(ast, {
    ExpressionStatement(nodePath) {
      const expr = nodePath.node.expression;
      if (!isCallExpr(expr)) return;
      if (!isMemberExpr(expr.callee)) return;

      const methodProp = expr.callee.property;
      if (!isIdentifier(methodProp)) return;

      const methodName = methodProp.name.toLowerCase();
      if (!(methodName in HTTP_METHODS)) return;

      const httpMethod = HTTP_METHODS[methodName] as HttpMethod;

      const args = expr.arguments;
      if (args.length < 1) return;

      const pathArg = args[0];
      if (!isStringLiteral(pathArg)) return;
      const routePath = pathArg.value;

      const line = getLine(expr);
      const objectNode = expr.callee.object;
      if (!isIdentifier(objectNode)) return;

      const callerName = objectNode.name;
      const mountInfo = mountTable.get(callerName);

      if (mountInfo !== undefined) {
        if (mountInfo.isNested) {
          // 巢狀 router → warn + 跳過
          const warnKey = `${relFile}:${line}`;
          if (!warnedNested.has(warnKey)) {
            warnedNested.add(warnKey);
            console.warn(
              `nested router beyond depth 1 skipped at ${relFile}:${line}`,
            );
          }
          return;
        }

        // depth-1 router → 組合完整路徑
        for (const prefix of mountInfo.prefixes) {
          const combined = (
            prefix.replace(/\/+$/, '') +
            '/' +
            routePath.replace(/^\/+/, '')
          ).replace(/\/$/, '') || '/';
          endpoints.push({
            method: httpMethod,
            path: combined,
            source: { file: relFile, line },
            framework: 'express',
          });
        }
      } else if (callerName === 'app' || callerName.endsWith('App')) {
        // 頂層 app.METHOD() 直接宣告
        endpoints.push({
          method: httpMethod,
          path: routePath,
          source: { file: relFile, line },
          framework: 'express',
        });
      }
    },
  });

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
   * 兩步驟解析：
   * 1. 全域掃描建立 mount 表
   * 2. 全域掃描根據 mount 表發出 endpoints
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

    // Step 1：建立全域 mount 表
    const mountTable = await buildGlobalMountTable(files);

    // Step 2：解析所有 endpoints
    const allEndpoints: ApiEndpoint[] = [];

    await Promise.all(
      files.map(async (filePath) => {
        const ast = await parseAst(filePath);
        if (ast === null) return;

        const relFile = relative(rootDir, filePath);
        const eps = extractEndpointsFromAst(ast, relFile, mountTable);
        allEndpoints.push(...eps);
      }),
    );

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
 */
export async function _parseFileForTesting(
  filePath: string,
  rootDir: string,
  externalMounts?: Map<string, MountInfo>,
): Promise<ApiEndpoint[]> {
  const ast = await parseAst(filePath);
  if (ast === null) return [];

  const relFile = relative(rootDir, filePath);

  // 先掃這個檔案的 use 關係，建立本地 mount 表
  let mountTable: Map<string, MountInfo>;
  if (externalMounts !== undefined) {
    mountTable = externalMounts;
  } else {
    // 只用單檔的 mount 關係（供 fixture 測試用）
    mountTable = await buildGlobalMountTable([filePath]);
  }

  return extractEndpointsFromAst(ast, relFile, mountTable);
}

// 重新導出 MountInfo 型別供測試使用
export type { MountInfo };
