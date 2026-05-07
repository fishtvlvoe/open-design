/**
 * codebase-scanner — Wave 7 mtime cache 測試
 *
 * 覆蓋場景：
 * (a) 首次掃描寫入 cache 檔（.open-design/scanner-cache.json）
 * (b) 第二次未改檔重用 cache（spy parser miss 必為 0）
 * (c) 改一檔後只 re-parse 那一檔
 * (d) cache schema 版本不符時忽略 cache 重新建立
 * (e) atomic write — 不會出現半寫入的毀損 cache 檔
 */

import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ScannerCache,
  getActiveCache,
  maybeCachedParse,
  setActiveCache,
} from '../cache.ts';

// ─── 工具 ────────────────────────────────────────────────────────────────────

async function makeTmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'od-cache-test-'));
}

async function writeFileWithMtime(
  filePath: string,
  content: string,
  mtimeSec?: number,
): Promise<void> {
  await writeFile(filePath, content, 'utf-8');
  if (mtimeSec !== undefined) {
    await utimes(filePath, mtimeSec, mtimeSec);
  }
}

// ─── Test Suite ──────────────────────────────────────────────────────────────

describe('codebase-scanner — Wave 7 ScannerCache', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
    setActiveCache(null);
  });

  afterEach(async () => {
    setActiveCache(null);
    await rm(tmpDir, { recursive: true, force: true });
  });

  // ─── Test (a)：首次寫入 ─────────────────────────────────────────────────

  it('(a) 首次掃描後 cache 檔被寫入正確路徑與結構', async () => {
    const filePath = join(tmpDir, 'a.ts');
    await writeFileWithMtime(filePath, 'console.log(1);');

    const cache = await ScannerCache.load(tmpDir);
    setActiveCache(cache);

    const parseSpy = vi.fn(async () => ({ value: 42 }));
    const result = await maybeCachedParse(filePath, 'ns-a', parseSpy);

    expect(result).toEqual({ value: 42 });
    expect(parseSpy).toHaveBeenCalledTimes(1);

    await cache.save();

    const cacheFilePath = join(tmpDir, '.open-design', 'scanner-cache.json');
    const raw = await readFile(cacheFilePath, 'utf-8');
    const parsed = JSON.parse(raw) as {
      version: number;
      entries: Record<string, { mtime: number; namespace: string; parsed: unknown }>;
    };

    expect(parsed.version).toBe(1);
    expect(Object.keys(parsed.entries)).toHaveLength(1);
    const entry = Object.values(parsed.entries)[0]!;
    expect(entry.namespace).toBe('ns-a');
    expect(entry.parsed).toEqual({ value: 42 });
    expect(typeof entry.mtime).toBe('number');
    expect(entry.mtime).toBeGreaterThan(0);
  });

  // ─── Test (b)：第二次重用 ────────────────────────────────────────────────

  it('(b) 第二次掃描未改檔時重用 cache，parser 不會被叫到', async () => {
    const filePath = join(tmpDir, 'b.ts');
    await writeFileWithMtime(filePath, 'export const x = 1;');

    // 第一次：填 cache
    const cache1 = await ScannerCache.load(tmpDir);
    setActiveCache(cache1);
    const parseSpy1 = vi.fn(async () => ({ tag: 'first' }));
    await maybeCachedParse(filePath, 'ns-b', parseSpy1);
    expect(parseSpy1).toHaveBeenCalledTimes(1);
    await cache1.save();
    setActiveCache(null);

    // 第二次：載入 cache，parser spy 不應被叫到
    const cache2 = await ScannerCache.load(tmpDir);
    setActiveCache(cache2);
    const parseSpy2 = vi.fn(async () => ({ tag: 'should-not-run' }));
    const result = await maybeCachedParse(filePath, 'ns-b', parseSpy2);

    expect(parseSpy2).toHaveBeenCalledTimes(0);
    expect(result).toEqual({ tag: 'first' });

    const stats = cache2.getStats();
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(0);
  });

  // ─── Test (c)：改一檔只 re-parse 該檔 ───────────────────────────────────

  it('(c) 修改一個檔後，只該檔重 parse，其他檔重用 cache', async () => {
    const fileA = join(tmpDir, 'a.ts');
    const fileB = join(tmpDir, 'b.ts');
    const fileC = join(tmpDir, 'c.ts');

    await writeFile(fileA, 'a v1', 'utf-8');
    await writeFile(fileB, 'b v1', 'utf-8');
    await writeFile(fileC, 'c v1', 'utf-8');

    // 第一次掃：所有檔 parse 一次
    const cache1 = await ScannerCache.load(tmpDir);
    setActiveCache(cache1);

    const parseSpy1 = vi.fn(async (path: string) => {
      const content = await readFile(path, 'utf-8');
      return { content };
    });

    await maybeCachedParse(fileA, 'ns-c', () => parseSpy1(fileA));
    await maybeCachedParse(fileB, 'ns-c', () => parseSpy1(fileB));
    await maybeCachedParse(fileC, 'ns-c', () => parseSpy1(fileC));
    expect(parseSpy1).toHaveBeenCalledTimes(3);

    await cache1.save();
    setActiveCache(null);

    // 等一個檔系 mtime tick（避免 mtime 一致導致 false hit）
    await new Promise((r) => setTimeout(r, 20));

    // 修改 fileB
    await writeFile(fileB, 'b v2 modified', 'utf-8');

    // 第二次掃
    const cache2 = await ScannerCache.load(tmpDir);
    setActiveCache(cache2);

    const parseSpy2 = vi.fn(async (path: string) => {
      const content = await readFile(path, 'utf-8');
      return { content };
    });

    const ra = await maybeCachedParse(fileA, 'ns-c', () => parseSpy2(fileA));
    const rb = await maybeCachedParse(fileB, 'ns-c', () => parseSpy2(fileB));
    const rc = await maybeCachedParse(fileC, 'ns-c', () => parseSpy2(fileC));

    // 只有 fileB 應觸發 parse（fileA / fileC 走 cache）
    expect(parseSpy2).toHaveBeenCalledTimes(1);
    expect((rb as { content: string }).content).toBe('b v2 modified');
    // fileA / fileC 拿到 cached v1 結果
    expect((ra as { content: string }).content).toBe('a v1');
    expect((rc as { content: string }).content).toBe('c v1');

    const stats = cache2.getStats();
    expect(stats.hits).toBe(2);
    expect(stats.misses).toBe(1);
  });

  // ─── Test (d)：版本不符時重建 ───────────────────────────────────────────

  it('(d) cache 檔版本不符時視為空 cache，不影響流程', async () => {
    const cacheDir = join(tmpDir, '.open-design');
    await mkdir(cacheDir, { recursive: true });
    const cacheFilePath = join(cacheDir, 'scanner-cache.json');

    // 寫入版本 999 的 cache（與當前 schema version=1 不符）
    await writeFile(
      cacheFilePath,
      JSON.stringify({ version: 999, entries: { 'ns:foo': { filePath: 'foo', mtime: 1, namespace: 'ns', parsed: 'old' } } }),
      'utf-8',
    );

    const cache = await ScannerCache.load(tmpDir);
    expect(cache.getStats().size).toBe(0);

    // 應仍能正常使用（不拋錯）
    const filePath = join(tmpDir, 'd.ts');
    await writeFile(filePath, 'd', 'utf-8');
    setActiveCache(cache);

    const parseSpy = vi.fn(async () => 'fresh');
    const result = await maybeCachedParse(filePath, 'ns-d', parseSpy);
    expect(result).toBe('fresh');
    expect(parseSpy).toHaveBeenCalledTimes(1);
  });

  // ─── Test (e)：JSON 毀損時 fallback 空 cache ─────────────────────────

  it('(e) cache 檔 JSON 毀損時 load 不拋錯，回傳空 cache', async () => {
    const cacheDir = join(tmpDir, '.open-design');
    await mkdir(cacheDir, { recursive: true });
    await writeFile(join(cacheDir, 'scanner-cache.json'), '{ not valid json', 'utf-8');

    const cache = await ScannerCache.load(tmpDir);
    expect(cache.getStats().size).toBe(0);
  });

  // ─── Test (f)：active cache 為 null 時 maybeCachedParse 直接執行 parseFn ─

  it('(f) 沒有 active cache 時直接執行 parseFn（向下相容）', async () => {
    setActiveCache(null);
    expect(getActiveCache()).toBeNull();

    const parseSpy = vi.fn(async () => 'no-cache');
    const result = await maybeCachedParse('/nonexistent', 'ns-x', parseSpy);
    expect(result).toBe('no-cache');
    expect(parseSpy).toHaveBeenCalledTimes(1);
  });

  // ─── Test (g)：不同 namespace 不會互相污染 ─────────────────────────────

  it('(g) 同檔不同 namespace 各自獨立快取', async () => {
    const filePath = join(tmpDir, 'g.ts');
    await writeFile(filePath, 'g content', 'utf-8');

    const cache = await ScannerCache.load(tmpDir);
    setActiveCache(cache);

    const r1 = await maybeCachedParse(filePath, 'ns-1', async () => 'value-1');
    const r2 = await maybeCachedParse(filePath, 'ns-2', async () => 'value-2');

    expect(r1).toBe('value-1');
    expect(r2).toBe('value-2');

    // 重複呼叫應走快取
    const spy = vi.fn(async () => 'should-not-run');
    const r1b = await maybeCachedParse(filePath, 'ns-1', spy);
    const r2b = await maybeCachedParse(filePath, 'ns-2', spy);
    expect(spy).toHaveBeenCalledTimes(0);
    expect(r1b).toBe('value-1');
    expect(r2b).toBe('value-2');
  });

  // ─── Test (h)：scanProject 整合 — 第二次掃描重用 cache ──────────────────

  it('(h) scanProject 第二次掃描時重用 cache（端對端）', async () => {
    // 建立一個假 nextjs 專案
    await writeFile(
      join(tmpDir, 'package.json'),
      JSON.stringify({ name: 'fixture', dependencies: { next: '14.0.0' } }),
      'utf-8',
    );
    const apiDir = join(tmpDir, 'app', 'api', 'hello');
    await mkdir(apiDir, { recursive: true });
    const routeFile = join(apiDir, 'route.ts');
    await writeFile(
      routeFile,
      "export async function GET() { return new Response('hi'); }",
      'utf-8',
    );

    // 動態 import scanProject 避免 module-level cache 污染
    const { scanProject } = await import('../index.ts');

    const r1 = await scanProject(tmpDir);
    expect(r1.apis.length).toBeGreaterThanOrEqual(1);
    expect(r1.apis.some((a) => a.method === 'GET' && a.path === '/api/hello')).toBe(true);

    // 確認 cache 檔生成
    const cachePath = join(tmpDir, '.open-design', 'scanner-cache.json');
    const cacheStat = await stat(cachePath);
    expect(cacheStat.isFile()).toBe(true);

    // 第二次掃：結果應一致
    const r2 = await scanProject(tmpDir);
    expect(r2.apis).toEqual(r1.apis);
  });
});
