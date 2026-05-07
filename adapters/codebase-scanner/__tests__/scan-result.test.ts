/**
 * codebase-scanner adapter — ScanResult 結構化輸出規格測試
 *
 * 覆蓋範圍：
 * - types.ts：ApiEndpointSchema 匯出驗證
 * - index.ts：scanProject() 回傳結構驗證
 * - registry.ts：registerParser() / _clearRegistryForTesting() 邏輯驗證
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ApiEndpointSchema,
  _clearRegistryForTesting,
  registerParser,
  scanProject,
} from '../index.ts';
import type { FrameworkParser } from '../registry.ts';

// ─── 測試輔助 ────────────────────────────────────────────────────────────────

/** 建立臨時空目錄，測試結束後自動清理 */
async function makeTmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'od-scanner-test-'));
}

// ─── Test Suite ──────────────────────────────────────────────────────────────

describe('codebase-scanner — ScanResult 結構化輸出規格', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
    _clearRegistryForTesting();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // ─── Test 1：ScanResult 結構正確性 ───────────────────────────────────────

  it('Test 1: scanProject 回傳完整 ScanResult 結構，registry 空時 apis/components 為空陣列', async () => {
    const result = await scanProject(tmpDir);

    // 驗證必要欄位存在
    expect(result).toHaveProperty('techStack');
    expect(result).toHaveProperty('apis');
    expect(result).toHaveProperty('components');
    expect(result).toHaveProperty('scannedAt');

    // 驗證型別
    expect(Array.isArray(result.techStack)).toBe(true);
    expect(Array.isArray(result.apis)).toBe(true);
    expect(Array.isArray(result.components)).toBe(true);
    expect(typeof result.scannedAt).toBe('string');

    // 驗證 scannedAt 是合法 ISO 8601
    const parsed = new Date(result.scannedAt);
    expect(Number.isNaN(parsed.getTime())).toBe(false);
    expect(result.scannedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);

    // registry 清空後 apis / components 應為空陣列
    expect(result.apis).toHaveLength(0);
    expect(result.components).toHaveLength(0);
  });

  // ─── Test 2：Registry 註冊機制 ───────────────────────────────────────────

  it('Test 2: 註冊 mock parser 後 scanProject 包含其回傳的 endpoint', async () => {
    const mockParser: FrameworkParser = {
      framework: 'express',
      detect: async () => true,
      parse: async () => [
        {
          method: 'POST',
          path: '/api/test',
          source: { file: 'test.ts', line: 1 },
          framework: 'express',
        },
      ],
    };

    registerParser(mockParser);

    const result = await scanProject(tmpDir);

    expect(result.apis).toHaveLength(1);
    const endpoint = result.apis[0];
    expect(endpoint).toBeDefined();
    // 使用型別縮窄確保 endpoint 不是 undefined
    if (!endpoint) throw new Error('endpoint is undefined');
    expect(endpoint.method).toBe('POST');
    expect(endpoint.path).toBe('/api/test');
    expect(endpoint.source.file).toBe('test.ts');
    expect(endpoint.source.line).toBe(1);
    expect(endpoint.framework).toBe('express');
  });

  // ─── Test 3：去重邏輯 ───────────────────────────────────────────────────

  it('Test 3: 兩個 parser 回傳相同 (method, path) 時，合併後只保留一個', async () => {
    const duplicateEndpoint = {
      method: 'GET' as const,
      path: '/api/health',
      source: { file: 'server.ts', line: 10 },
      framework: 'express' as const,
    };

    const parserA: FrameworkParser = {
      framework: 'express',
      detect: async () => true,
      parse: async () => [duplicateEndpoint],
    };

    const parserB: FrameworkParser = {
      framework: 'nextjs',
      detect: async () => true,
      parse: async () => [
        {
          ...duplicateEndpoint,
          // 同一個 (method, path)，但來源不同的 parser
          source: { file: 'pages/api/health.ts', line: 1 },
          framework: 'nextjs' as const,
        },
      ],
    };

    registerParser(parserA);
    registerParser(parserB);

    const result = await scanProject(tmpDir);

    // GET /api/health 只應出現一次
    const healthEndpoints = result.apis.filter(
      (e) => e.method === 'GET' && e.path === '/api/health',
    );
    expect(healthEndpoints).toHaveLength(1);
    // 總共只有一個（兩個 parser 同一個 key，第二個被去重）
    expect(result.apis).toHaveLength(1);
  });

  // ─── Test 4：JSON Schema 匯出 ────────────────────────────────────────────

  it('Test 4: ApiEndpointSchema 匯出為有效 JSON Schema 物件', () => {
    // 驗證是物件
    expect(typeof ApiEndpointSchema).toBe('object');
    expect(ApiEndpointSchema).not.toBeNull();

    // 驗證 JSON Schema 基本結構
    expect(ApiEndpointSchema.type).toBe('object');
    expect(ApiEndpointSchema).toHaveProperty('properties');
    expect(typeof ApiEndpointSchema.properties).toBe('object');

    // 驗證 required 欄位存在且包含核心屬性
    expect(Array.isArray(ApiEndpointSchema.required)).toBe(true);
    expect(ApiEndpointSchema.required).toContain('method');
    expect(ApiEndpointSchema.required).toContain('path');
    expect(ApiEndpointSchema.required).toContain('source');
    expect(ApiEndpointSchema.required).toContain('framework');

    // 驗證 properties 包含核心欄位
    expect(ApiEndpointSchema.properties).toHaveProperty('method');
    expect(ApiEndpointSchema.properties).toHaveProperty('path');
    expect(ApiEndpointSchema.properties).toHaveProperty('source');
    expect(ApiEndpointSchema.properties).toHaveProperty('framework');
  });
});
