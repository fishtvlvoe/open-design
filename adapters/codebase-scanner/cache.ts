/**
 * codebase-scanner — mtime-based 解析結果快取
 *
 * 設計目標（Wave 7）：
 * - 首次掃描 5,000 檔案 < 30 秒（Apple Silicon）
 * - 增量掃描（無檔案變動）< 5 秒
 * - 改一檔只重 parse 該檔
 *
 * 機制：
 * 1. 快取檔位於 `<rootDir>/.open-design/scanner-cache.json`
 * 2. Key 為「檔案絕對路徑」，Value 含 `{ mtime, namespace, parsed }`
 * 3. 同一檔可被不同 namespace（例如 'express'、'nextjs'、'ui-button-meta'）快取
 * 4. mtime 一致 → 直接回 cached.parsed，跳過重 parse
 * 5. 寫入用「temp file + rename」原子操作，避免半寫入造成下次讀取毀損
 *
 * 注意：
 * - parsed 內容是 unknown，呼叫端負責型別斷言
 * - cache schema 版本 = 1；版本不符直接視為空快取重建
 */

import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

// ─── 常數 ────────────────────────────────────────────────────────────────────

/** 快取檔 schema 版本（改 schema 時必須 bump） */
const CACHE_SCHEMA_VERSION = 1 as const;

/** 快取檔相對於 rootDir 的路徑 */
const CACHE_REL_PATH = '.open-design/scanner-cache.json';

// ─── 型別 ────────────────────────────────────────────────────────────────────

/**
 * 單筆快取條目。
 * - filePath 為絕對路徑（key 本身已存路徑，這裡是冗餘但便利於除錯）
 * - mtime 為檔案 mtime 的 ms timestamp（fs.Stats.mtimeMs）
 * - namespace 為呼叫端類型識別（避免 express 的解析結果被 nextjs 重用）
 * - parsed 為解析後物件，型別由 namespace 約定（呼叫端做斷言）
 */
export interface CacheEntry {
  filePath: string;
  mtime: number;
  namespace: string;
  parsed: unknown;
}

/**
 * 整體快取結構。
 * - version：schema 版本，與 CACHE_SCHEMA_VERSION 比對
 * - entries：以「namespace + ':' + 絕對路徑」為 key 的條目表
 */
export interface ScannerCacheFile {
  version: number;
  entries: Record<string, CacheEntry>;
}

/** 快取檔對應的 JSON Schema（與其他型別風格一致，無外部依賴） */
export const ScannerCacheSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  required: ['version', 'entries'],
  additionalProperties: false,
  properties: {
    version: { type: 'integer', minimum: 1 },
    entries: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        required: ['filePath', 'mtime', 'namespace', 'parsed'],
        additionalProperties: false,
        properties: {
          filePath: { type: 'string' },
          mtime: { type: 'number' },
          namespace: { type: 'string' },
          parsed: {}, // any
        },
      },
    },
  },
} as const;

// ─── ScannerCache 主類別 ──────────────────────────────────────────────────────

/**
 * 一個 ScannerCache 實例對應一次掃描；同一進程可開多個（不同 rootDir）。
 *
 * 生命週期：
 * 1. `await ScannerCache.load(rootDir)` 從磁碟載入或開新空快取
 * 2. 過程中呼叫 `withFileCache(filePath, namespace, parseFn)` 取結果
 * 3. `await cache.save()` 寫回磁碟（原子寫入）
 *
 * 統計：
 * - hits / misses 由 `withFileCache` 自動累計，便於效能驗證
 */
export class ScannerCache {
  private readonly rootDir: string;
  private readonly cacheFilePath: string;
  private entries: Record<string, CacheEntry>;
  private hits = 0;
  private misses = 0;

  private constructor(
    rootDir: string,
    cacheFilePath: string,
    entries: Record<string, CacheEntry>,
  ) {
    this.rootDir = rootDir;
    this.cacheFilePath = cacheFilePath;
    this.entries = entries;
  }

  /**
   * 從 `<rootDir>/.open-design/scanner-cache.json` 讀入。
   * 檔案不存在、毀損、或 schema 版本不符時，回傳空快取（不拋錯）。
   */
  static async load(rootDir: string): Promise<ScannerCache> {
    const absRoot = resolve(rootDir);
    const cacheFilePath = join(absRoot, CACHE_REL_PATH);

    let raw: string;
    try {
      raw = await readFile(cacheFilePath, 'utf-8');
    } catch {
      // 檔案不存在或無法讀取 → 開空快取
      return new ScannerCache(absRoot, cacheFilePath, {});
    }

    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      // JSON 毀損 → 開空快取
      return new ScannerCache(absRoot, cacheFilePath, {});
    }

    if (
      typeof data !== 'object' ||
      data === null ||
      (data as { version?: unknown }).version !== CACHE_SCHEMA_VERSION ||
      typeof (data as { entries?: unknown }).entries !== 'object' ||
      (data as { entries?: unknown }).entries === null
    ) {
      // 版本不符或結構錯誤 → 開空快取
      return new ScannerCache(absRoot, cacheFilePath, {});
    }

    const entries = (data as ScannerCacheFile).entries;
    return new ScannerCache(absRoot, cacheFilePath, entries);
  }

  /**
   * 取得 file 的 mtime（ms）。檔案不存在回 null。
   */
  private async getMtime(filePath: string): Promise<number | null> {
    try {
      const s = await stat(filePath);
      return s.mtimeMs;
    } catch {
      return null;
    }
  }

  /**
   * 組合 cache key：namespace + ':' + 絕對路徑
   */
  private static keyFor(namespace: string, absPath: string): string {
    return `${namespace}:${absPath}`;
  }

  /**
   * 命中 mtime 一致時回 cached.parsed；否則執行 parseFn，寫入快取後回新結果。
   *
   * @param filePath - 必須是絕對路徑（呼叫端負責 resolve）
   * @param namespace - 呼叫端類型，例如 'express'、'nextjs-route'、'ui-component'
   * @param parseFn - 真正的 parse 函式，僅在 cache miss 時執行
   */
  async withFileCache<T>(
    filePath: string,
    namespace: string,
    parseFn: () => Promise<T>,
  ): Promise<T> {
    const absPath = resolve(filePath);
    const key = ScannerCache.keyFor(namespace, absPath);

    const currentMtime = await this.getMtime(absPath);

    // 檔案不存在 → 不快取，直接跑 parseFn（理論上 parseFn 也會失敗）
    if (currentMtime === null) {
      this.misses++;
      return parseFn();
    }

    const cached = this.entries[key];
    if (cached !== undefined && cached.mtime === currentMtime) {
      this.hits++;
      return cached.parsed as T;
    }

    // miss：跑 parseFn 並寫快取
    this.misses++;
    const parsed = await parseFn();

    this.entries[key] = {
      filePath: absPath,
      mtime: currentMtime,
      namespace,
      parsed,
    };

    return parsed;
  }

  /**
   * 將快取寫回磁碟（原子寫入：先寫 .tmp，再 rename）。
   * 寫入失敗時靜默忽略（log 到 console.warn，不拋錯影響掃描流程）。
   */
  async save(): Promise<void> {
    const data: ScannerCacheFile = {
      version: CACHE_SCHEMA_VERSION,
      entries: this.entries,
    };

    const json = JSON.stringify(data);
    const tmpPath = `${this.cacheFilePath}.tmp`;

    try {
      await mkdir(dirname(this.cacheFilePath), { recursive: true });
      await writeFile(tmpPath, json, 'utf-8');
      await rename(tmpPath, this.cacheFilePath);
    } catch (err) {
      console.warn(
        `scanner-cache save failed at ${this.cacheFilePath}: ${(err as Error).message}`,
      );
    }
  }

  /** 取得統計（cache hit / miss 次數），主要供測試與效能驗證 */
  getStats(): { hits: number; misses: number; size: number } {
    return {
      hits: this.hits,
      misses: this.misses,
      size: Object.keys(this.entries).length,
    };
  }

  /** 清空快取記憶體內容（不影響磁碟，呼叫 save 後才真正寫入） */
  clear(): void {
    this.entries = {};
    this.hits = 0;
    this.misses = 0;
  }

  /** 取得快取檔絕對路徑（測試用） */
  getCacheFilePath(): string {
    return this.cacheFilePath;
  }
}

// ─── 全域 active cache（簡化 parser 整合，避免改 FrameworkParser 介面） ───────

/**
 * 目前掃描中使用的 cache 實例。
 * 由 `scanProject()` / `scanUiComponents()` 入口設定，parser 內部讀取。
 *
 * 為何用全域：FrameworkParser 介面是 `parse(rootDir)`，
 * 無法在不破壞對外 API 的前提下多塞 cache 參數。
 * Trade-off：同一進程內多 scanProject 並行會互相覆蓋——v1 不支援並行掃描。
 */
let activeCache: ScannerCache | null = null;

/** 設定目前進程使用的 cache 實例（由 scanProject 入口呼叫） */
export function setActiveCache(cache: ScannerCache | null): void {
  activeCache = cache;
}

/** 取得目前進程使用的 cache 實例（parser 內部呼叫） */
export function getActiveCache(): ScannerCache | null {
  return activeCache;
}

/**
 * 給 parser 用的便利 wrapper：
 * 若有 active cache 則走 cache，沒有就直接跑 parseFn。
 *
 * 這個 helper 確保 parser 不需要知道 cache 是否啟用——
 * 沒啟用時等同於直接執行（向下相容）。
 */
export async function maybeCachedParse<T>(
  filePath: string,
  namespace: string,
  parseFn: () => Promise<T>,
): Promise<T> {
  const cache = getActiveCache();
  if (cache === null) {
    return parseFn();
  }
  return cache.withFileCache(filePath, namespace, parseFn);
}
