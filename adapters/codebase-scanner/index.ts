/**
 * codebase-scanner adapter — 主要入口
 *
 * 提供 scanProject() 公開函式，掃描指定根目錄並回傳 ScanResult。
 *
 * 流程：
 * 1. 載入 mtime cache（Wave 7：`<rootDir>/.open-design/scanner-cache.json`）
 * 2. 讀取 package.json 偵測 techStack
 * 3. 從 registry 取得所有已註冊的 parser
 * 4. 平行呼叫每個 parser 的 detect()，篩出匹配的 parser
 * 5. 平行呼叫匹配 parser 的 parse()（內部會走 cache）
 * 6. 合併 + 去重 API endpoints
 * 7. 儲存 cache 後組合 ScanResult 回傳
 *
 * 注意：cache 採全域 active 模式（見 cache.ts），同一進程不支援並行掃描多 rootDir。
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ScanResult, ApiEndpoint } from './types.ts';
import { getRegistered } from './registry.ts';
import { ScannerCache, setActiveCache } from './cache.ts';

// ─── 自動載入 parsers（觸發 registerParser 副作用） ─────────────────────────
// 新增 parser 時，在這裡加一行 import。
import './parsers/express-parser.ts';
import './parsers/nextjs-parser.ts';
import './parsers/wordpress-parser.ts';
import './parsers/openapi-parser.ts';

// ─── 主函式 ──────────────────────────────────────────────────────────────────

/**
 * 掃描目標專案根目錄，回傳結構化的 ScanResult。
 *
 * @param rootDir - 目標專案的絕對路徑（或相對於 cwd 的路徑）
 * @returns ScanResult，包含 techStack、apis、components、scannedAt
 */
export async function scanProject(rootDir: string): Promise<ScanResult> {
  // ─── Wave 7：載入 mtime cache ─────────────────────────────────────────────
  // 載入失敗時 ScannerCache.load 會回傳空快取（不拋錯），不影響掃描流程。
  const cache = await ScannerCache.load(rootDir);
  setActiveCache(cache);

  try {
    const techStack = await detectTechStack(rootDir);
    const apis = await gatherApis(rootDir);

    return {
      techStack,
      apis,
      // components scanner 在 Wave 3 實作；Wave 7 起也走 cache（內部呼叫 maybeCachedParse）
      components: [],
      scannedAt: new Date().toISOString(),
    };
  } finally {
    // 不論成功失敗都嘗試寫回 cache（避免下一次掃描丟失部分 hit）
    // 並清掉 activeCache 避免污染後續呼叫
    try {
      await cache.save();
    } finally {
      setActiveCache(null);
    }
  }
}

// ─── 內部輔助函式 ────────────────────────────────────────────────────────────

/**
 * 讀取 package.json 偵測技術棧。
 * 無法讀取時（非 Node 專案）回傳空陣列，不拋出錯誤。
 */
async function detectTechStack(rootDir: string): Promise<string[]> {
  const pkgPath = join(rootDir, 'package.json');

  let pkgJson: unknown;
  try {
    const raw = await readFile(pkgPath, 'utf-8');
    pkgJson = JSON.parse(raw);
  } catch {
    // 非 Node 專案或無法讀取 package.json，techStack 保持空
    return [];
  }

  if (typeof pkgJson !== 'object' || pkgJson === null) {
    return [];
  }

  const stack: string[] = [];

  // 合併 dependencies + devDependencies 做偵測
  const allDeps = {
    ...getStringRecord(pkgJson, 'dependencies'),
    ...getStringRecord(pkgJson, 'devDependencies'),
  };

  // 框架偵測規則（依優先序）
  if ('next' in allDeps) stack.push('nextjs');
  if ('express' in allDeps) stack.push('express');
  if ('fastify' in allDeps) stack.push('fastify');
  if ('koa' in allDeps) stack.push('koa');
  if ('hono' in allDeps) stack.push('hono');

  // PHP / WordPress 靠特徵檔偵測，不靠 package.json（在 parsers 內處理）

  return stack;
}

/**
 * 安全取出物件中某個 key 的值（型別斷言 helper）。
 */
function getStringRecord(
  obj: object,
  key: string,
): Record<string, string> {
  const val = (obj as Record<string, unknown>)[key];
  if (typeof val !== 'object' || val === null) return {};
  return val as Record<string, string>;
}

/**
 * 呼叫所有已註冊 parser 的 detect() + parse()，合併並去重 API endpoints。
 */
async function gatherApis(rootDir: string): Promise<ApiEndpoint[]> {
  const parsers = getRegistered();

  if (parsers.length === 0) {
    return [];
  }

  // 平行偵測哪些 parser 適用此專案
  const detectResults = await Promise.all(
    parsers.map(async (parser) => ({
      parser,
      matched: await parser.detect(rootDir),
    })),
  );

  const matchedParsers = detectResults
    .filter((r) => r.matched)
    .map((r) => r.parser);

  if (matchedParsers.length === 0) {
    return [];
  }

  // 平行執行所有匹配 parser 的 parse()
  const apiGroups = await Promise.all(
    matchedParsers.map((parser) => parser.parse(rootDir)),
  );

  // 合併 + 去重（以 method + path 為唯一鍵）
  const seen = new Set<string>();
  const merged: ApiEndpoint[] = [];

  for (const group of apiGroups) {
    for (const endpoint of group) {
      const key = `${endpoint.method}:${endpoint.path}`;
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(endpoint);
      }
    }
  }

  return merged;
}

// ─── 重新匯出型別與 registry，方便使用者一站取用 ────────────────────────────

export type {
  ApiEndpoint,
  UiComponent,
  ScanResult,
  ConnectionMap,
  ExportInput,
  HttpMethod,
  Framework,
  UiComponentType,
  ConnectionStatus,
} from './types.ts';

export {
  ApiEndpointSchema,
  UiComponentSchema,
  ScanResultSchema,
  ConnectionMapSchema,
  ExportInputSchema,
} from './types.ts';

export {
  registerParser,
  getRegistered,
  _clearRegistryForTesting,
} from './registry.ts';

export type { FrameworkParser } from './registry.ts';

// ─── UI Component Scanner ────────────────────────────────────────────────────
export { scanUiComponents, fuzzyFindComponent } from './ui-component-scanner.ts';

// ─── Wave 7：Cache 公開介面 ─────────────────────────────────────────────────
export { ScannerCache, ScannerCacheSchema } from './cache.ts';
export type { CacheEntry, ScannerCacheFile } from './cache.ts';
