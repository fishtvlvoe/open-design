/**
 * codebase-scanner adapter — parser 註冊表
 *
 * 設計決策（design.md）：
 * 採可擴充 parser 註冊架構，每種後端框架是一個獨立模組，
 * 實作共同 FrameworkParser 介面，未來新增框架只需新增一個 parser 檔。
 *
 * 第一版：空 registry，等 Wave 2 才依序注入 Express / Next.js / WordPress / OpenAPI parser。
 */

import type { ApiEndpoint, Framework } from './types.ts';

// ─── Parser 介面 ────────────────────────────────────────────────────────────

export interface FrameworkParser {
  /** 此 parser 負責的框架識別碼 */
  framework: Framework;
  /**
   * 偵測 rootDir 是否使用此框架。
   * 實作應盡量輕量（讀 package.json / 找特徵檔），不做深度 AST 解析。
   */
  detect(rootDir: string): Promise<boolean>;
  /**
   * 解析 rootDir 內的 API endpoint。
   * 只在 detect() 回傳 true 後才會被呼叫。
   */
  parse(rootDir: string): Promise<ApiEndpoint[]>;
}

// ─── 內部 registry ───────────────────────────────────────────────────────────

/**
 * 已註冊的 parser 清單。
 * 模組層級單例——同一個 Node.js 進程內只有一份。
 */
const registry: FrameworkParser[] = [];

// ─── 公開 API ────────────────────────────────────────────────────────────────

/**
 * 向 registry 註冊一個 parser。
 * 若同一 framework 已有 parser，新的會附加在後方（允許覆蓋實驗）。
 */
export function registerParser(parser: FrameworkParser): void {
  registry.push(parser);
}

/**
 * 取得目前所有已註冊的 parser（唯讀視圖，避免外部直接修改陣列）。
 */
export function getRegistered(): readonly FrameworkParser[] {
  return registry;
}

/**
 * 清除所有已註冊的 parser（僅供測試使用）。
 * 正式程式碼不應呼叫此函式。
 */
export function _clearRegistryForTesting(): void {
  registry.length = 0;
}
