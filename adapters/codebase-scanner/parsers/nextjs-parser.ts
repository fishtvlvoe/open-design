/**
 * Next.js App Router parser
 *
 * 偵測並解析 app/api/ 下所有 route.ts/tsx/js/jsx 的 HTTP handler export。
 *
 * detect: 讀 package.json 確認有 next dependency，且 app/api/ 目錄存在。
 * parse: 遞迴掃 app/api 下所有 route 檔，用 @babel/parser 偵測以下 export 模式：
 *   a) export async function GET(...)
 *   b) export const GET = ...
 *   c) export { handler as GET, handler as POST }
 *   d) export { GET } from '...' (re-export)
 *
 * 動態路由段 [id] 和 [...slug] 保留原樣。
 * 自動呼叫 registerParser 掛入 registry。
 *
 * Wave 7：per-file 結果（methods + firstExportLine）走 mtime cache，
 * 同一檔未變動時跳過 readFile + babel parse + AST traverse。
 */

import { readFile, stat } from 'node:fs/promises';
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
const traverse = (traverseModule.default ?? traverseModule) as (
  ast: ReturnType<typeof babelParse>,
  visitor: Record<string, (path: { node: unknown }) => void>,
) => void;

// ─── 常數 ────────────────────────────────────────────────────────────────────

/** Next.js App Router 支援的 HTTP method export 名稱（大寫） */
const NEXTJS_HTTP_METHODS = new Set<HttpMethod>([
  'GET',
  'POST',
  'PUT',
  'DELETE',
  'PATCH',
]);

/** Wave 7：cache namespace（隔離不同 parser 的快取結果） */
const CACHE_NAMESPACE = 'nextjs-route';

// ─── 型別工具 ─────────────────────────────────────────────────────────────────

function isIdentifier(node: unknown, name?: string): node is { type: 'Identifier'; name: string } {
  if ((node as { type?: string } | null)?.type !== 'Identifier') return false;
  if (name !== undefined) return (node as { name?: string }).name === name;
  return true;
}

function isStringLiteral(node: unknown): node is { type: 'StringLiteral'; value: string } {
  return (node as { type?: string } | null)?.type === 'StringLiteral';
}

function getLine(node: unknown): number {
  return (node as { loc?: { start?: { line?: number } } } | null)?.loc?.start?.line ?? 1;
}

function toHttpMethod(name: string): HttpMethod | null {
  const upper = name.toUpperCase() as HttpMethod;
  if (NEXTJS_HTTP_METHODS.has(upper)) return upper;
  return null;
}

// ─── 路徑推算 ─────────────────────────────────────────────────────────────────

/**
 * 從 route 檔案的相對路徑（相對於 rootDir）推算 API URL path。
 *
 * 範例：
 *   app/api/chat/message/route.ts         → /api/chat/message
 *   app/api/notifications/[id]/read/route.ts → /api/notifications/[id]/read
 *   app/api/auth/[...nextauth]/route.ts   → /api/auth/[...nextauth]
 *
 * 策略：
 * 1. 去掉 "app/" 前綴（App Router 的根目錄）
 * 2. 去掉結尾的 "/route.{ext}" 部分
 * 3. 動態段 [xxx] 與 [...xxx] 保留原樣
 */
function filePathToApiPath(relFilePath: string): string {
  // 統一分隔符號為 /
  const normalized = relFilePath.replace(/\\/g, '/');

  // 去掉 "app/" 前綴
  const withoutApp = normalized.startsWith('app/')
    ? normalized.slice('app/'.length)
    : normalized;

  // 去掉結尾的 "/route.{ext}"
  const withoutRoute = withoutApp.replace(/\/route\.[^/]+$/, '');

  // 確保以 / 開頭
  const apiPath = withoutRoute.startsWith('/') ? withoutRoute : '/' + withoutRoute;

  return apiPath;
}

// ─── AST 解析 ─────────────────────────────────────────────────────────────────

/**
 * 單一 route 檔解析後的 cached payload：
 * 含 HTTP methods 與「第一個 export 出現的行號」。
 */
interface RouteFilePayload {
  methods: HttpMethod[];
  firstExportLine: number;
}

/**
 * 解析單一 route 檔的 AST，回傳偵測到的 HTTP methods 與第一個 export 行號。
 * 此函式是 cache miss 時實際跑的 parse 邏輯。
 */
async function parseRouteFileImpl(filePath: string): Promise<RouteFilePayload> {
  let source: string;
  try {
    source = await readFile(filePath, 'utf-8');
  } catch {
    return { methods: [], firstExportLine: 1 };
  }

  let ast: ReturnType<typeof babelParse>;
  try {
    ast = babelParse(source, {
      sourceType: 'module',
      plugins: ['typescript', 'decorators'],
      errorRecovery: true,
    });
  } catch {
    return { methods: [], firstExportLine: 1 };
  }

  const methodSet = new Set<HttpMethod>();

  traverse(ast, {
    // 模式 a：`export async function GET(...)` / `export function POST(...)`
    ExportNamedDeclaration(nodePath: { node: unknown }) {
      const node = nodePath.node as {
        declaration?: unknown;
        specifiers?: unknown[];
        source?: unknown;
      };

      // 情況 a：export function/async function 宣告
      if (node.declaration !== null && node.declaration !== undefined) {
        const decl = node.declaration as {
          type?: string;
          id?: unknown;
          declarations?: Array<{ id: unknown; init?: unknown }>;
        };

        if (decl.type === 'FunctionDeclaration' || decl.type === 'TSDeclareFunction') {
          // export function GET / export async function POST
          if (isIdentifier(decl.id)) {
            const m = toHttpMethod(decl.id.name);
            if (m !== null) methodSet.add(m);
          }
        } else if (decl.type === 'VariableDeclaration') {
          // export const GET = ...
          const declarations = decl.declarations ?? [];
          for (const varDecl of declarations) {
            if (isIdentifier(varDecl.id)) {
              const m = toHttpMethod(varDecl.id.name);
              if (m !== null) methodSet.add(m);
            }
          }
        }
        return;
      }

      // 情況 b：export { handler as GET, handler as POST }
      // 情況 d：export { GET } from '...'
      const specifiers = node.specifiers ?? [];
      for (const spec of specifiers) {
        const s = spec as {
          type?: string;
          exported?: unknown;
          local?: unknown;
        };
        if (s.type !== 'ExportSpecifier') continue;

        // exported 是最終 export 出去的名稱
        const exported = s.exported;
        let exportedName: string | null = null;
        if (isIdentifier(exported)) {
          exportedName = exported.name;
        } else if (isStringLiteral(exported)) {
          exportedName = exported.value;
        }

        if (exportedName !== null) {
          const m = toHttpMethod(exportedName);
          if (m !== null) methodSet.add(m);
        }
      }
    },
  });

  // 找第一個 export 行號
  const lines = source.split('\n');
  const exportLineIdx = lines.findIndex((l) => l.trimStart().startsWith('export'));
  const firstExportLine = exportLineIdx >= 0 ? exportLineIdx + 1 : 1;

  return { methods: [...methodSet], firstExportLine };
}

/**
 * Cache-aware wrapper：包 parseRouteFileImpl，命中時直接回 cached payload。
 */
async function parseRouteFile(filePath: string): Promise<RouteFilePayload> {
  return maybeCachedParse<RouteFilePayload>(
    filePath,
    CACHE_NAMESPACE,
    () => parseRouteFileImpl(filePath),
  );
}

// ─── FrameworkParser 實作 ─────────────────────────────────────────────────────

const nextjsParser: FrameworkParser = {
  framework: 'nextjs',

  /**
   * 偵測方式：
   * 1. 讀根目錄 package.json，確認 dependencies 中含 'next'
   * 2. 確認 app/api/ 目錄存在
   */
  async detect(rootDir: string): Promise<boolean> {
    // 檢查 package.json 有 next dependency
    let pkgJson: unknown;
    try {
      const raw = await readFile(join(rootDir, 'package.json'), 'utf-8');
      pkgJson = JSON.parse(raw) as unknown;
    } catch {
      return false;
    }

    if (typeof pkgJson !== 'object' || pkgJson === null) return false;

    const pkg = pkgJson as Record<string, unknown>;
    const allDeps = {
      ...((pkg['dependencies'] ?? {}) as Record<string, unknown>),
      ...((pkg['devDependencies'] ?? {}) as Record<string, unknown>),
    };

    if (!('next' in allDeps)) return false;

    // 確認 app/api/ 目錄存在
    try {
      const s = await stat(join(rootDir, 'app', 'api'));
      return s.isDirectory();
    } catch {
      return false;
    }
  },

  /**
   * 解析所有 app/api 下的 route.ts/tsx/js/jsx 檔案，回傳 ApiEndpoint 陣列。
   */
  async parse(rootDir: string): Promise<ApiEndpoint[]> {
    let files: string[];
    try {
      files = await fg(['app/api/**/route.{ts,tsx,js,jsx}'], {
        cwd: rootDir,
        absolute: true,
        ignore: [
          '**/node_modules/**',
          '**/.next/**',
          '**/dist/**',
          '**/build/**',
        ],
      });
    } catch {
      return [];
    }

    const allEndpoints: ApiEndpoint[] = [];

    await Promise.all(
      files.map(async (filePath) => {
        const relFile = relative(rootDir, filePath);
        const apiPath = filePathToApiPath(relFile);
        const { methods, firstExportLine } = await parseRouteFile(filePath);

        for (const method of methods) {
          allEndpoints.push({
            method,
            path: apiPath,
            source: { file: relFile, line: firstExportLine },
            framework: 'nextjs',
          });
        }
      }),
    );

    return allEndpoints;
  },
};

// ─── 自動註冊 ─────────────────────────────────────────────────────────────────

registerParser(nextjsParser);

// ─── 匯出（供測試直接使用）─────────────────────────────────────────────────────

export { nextjsParser };

/**
 * 供測試用：解析單一 route 檔字串，回傳偵測到的 HTTP methods（不走 cache）
 *
 * 注意：v1 介面回傳 HttpMethod[]，這裡保留同樣簽名（呼叫 impl 後取 methods 欄位）。
 */
export async function _parseRouteFileForTesting(filePath: string): Promise<HttpMethod[]> {
  const { methods } = await parseRouteFileImpl(filePath);
  return methods;
}

/**
 * 供測試用：檔案路徑轉 API path
 */
export { filePathToApiPath as _filePathToApiPathForTesting };
