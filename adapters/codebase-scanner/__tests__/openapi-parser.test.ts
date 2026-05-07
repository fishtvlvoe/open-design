/**
 * openapi-parser 單元測試
 *
 * 覆蓋範圍：
 * - detect(): 找到 OpenAPI 3.x 檔案 → true
 * - detect(): 沒有符合的檔案 → false
 * - parse(): OpenAPI 3.x YAML → 正確擷取 endpoints
 * - parse(): Swagger 2.0 → console.warn + 回傳空陣列
 * - parse(): 複數 endpoints、parameters 與 requestBody 解析
 * - 真實 inkgo 掃描：detect true + endpoints >= 100
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openapiParser, _parseYamlStringForTesting } from '../parsers/openapi-parser.ts';

// ─── 測試輔助 ────────────────────────────────────────────────────────────────

async function makeTmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'od-openapi-test-'));
}

/** 最簡 OpenAPI 3.x YAML */
const MINIMAL_V3_YAML = `
openapi: 3.1.0
info:
  title: Test API
  version: "1.0.0"
paths:
  /users:
    get:
      summary: List users
  /users/{id}:
    get:
      summary: Get user
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string
    delete:
      summary: Delete user
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: integer
  /users/{id}/posts:
    post:
      summary: Create post
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string
        - name: draft
          in: query
          required: false
          schema:
            type: boolean
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              properties:
                title:
                  type: string
                body:
                  type: string
`.trim();

/** Swagger 2.0 YAML（應被跳過） */
const SWAGGER_V2_YAML = `
swagger: "2.0"
info:
  title: Old API
  version: "1.0"
paths:
  /items:
    get:
      summary: List items
`.trim();

// ─── Test Suite: detect() ─────────────────────────────────────────────────────

describe('OpenAPI Parser — detect()', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('Test D1: 根目錄有 openapi.yaml（v3）→ detect() 回傳 true', async () => {
    await writeFile(join(tmpDir, 'openapi.yaml'), MINIMAL_V3_YAML);
    const result = await openapiParser.detect(tmpDir);
    expect(result).toBe(true);
  });

  it('Test D2: 子目錄有 api.openapi.yaml（v3）→ detect() 回傳 true', async () => {
    const subDir = join(tmpDir, 'docs', 'api');
    await mkdir(subDir, { recursive: true });
    await writeFile(join(subDir, 'api.openapi.yaml'), MINIMAL_V3_YAML);
    const result = await openapiParser.detect(tmpDir);
    expect(result).toBe(true);
  });

  it('Test D3: 只有 Swagger 2.0 → detect() 回傳 false', async () => {
    await writeFile(join(tmpDir, 'swagger.yaml'), SWAGGER_V2_YAML);
    const result = await openapiParser.detect(tmpDir);
    expect(result).toBe(false);
  });

  it('Test D4: 完全沒有 yaml/json → detect() 回傳 false', async () => {
    const result = await openapiParser.detect(tmpDir);
    expect(result).toBe(false);
  });
});

// ─── Test Suite: _parseYamlStringForTesting() ────────────────────────────────

describe('OpenAPI Parser — parse() via _parseYamlStringForTesting()', () => {

  it('Test P1: OpenAPI 3.x YAML → 正確擷取所有 method + path', () => {
    const endpoints = _parseYamlStringForTesting(MINIMAL_V3_YAML, 'openapi.yaml');

    // 應有 4 個 endpoints：GET /users、GET+DELETE /users/{id}、POST /users/{id}/posts
    expect(endpoints).toHaveLength(4);

    const methods = endpoints.map((e) => e.method);
    expect(methods).toContain('GET');
    expect(methods).toContain('DELETE');
    expect(methods).toContain('POST');

    const paths = endpoints.map((e) => e.path);
    expect(paths).toContain('/users');
    expect(paths).toContain('/users/{id}');
    expect(paths).toContain('/users/{id}/posts');
  });

  it('Test P2: framework 欄位為 "openapi"', () => {
    const endpoints = _parseYamlStringForTesting(MINIMAL_V3_YAML, 'api.yaml');
    expect(endpoints.every((e) => e.framework === 'openapi')).toBe(true);
  });

  it('Test P3: source.file 正確記錄傳入的 relFile', () => {
    const endpoints = _parseYamlStringForTesting(MINIMAL_V3_YAML, 'docs/openapi.yaml');
    expect(endpoints.every((e) => e.source.file === 'docs/openapi.yaml')).toBe(true);
  });

  it('Test P4: path 參數被解析到 parameters[]', () => {
    const endpoints = _parseYamlStringForTesting(MINIMAL_V3_YAML, 'openapi.yaml');
    const getUser = endpoints.find((e) => e.path === '/users/{id}' && e.method === 'GET');
    expect(getUser?.parameters).toEqual([
      { name: 'id', type: 'string', required: true },
    ]);
  });

  it('Test P5: query 參數被解析到 parameters[]（required: false）', () => {
    const endpoints = _parseYamlStringForTesting(MINIMAL_V3_YAML, 'openapi.yaml');
    const createPost = endpoints.find((e) => e.path === '/users/{id}/posts');
    const draft = createPost?.parameters?.find((p) => p.name === 'draft');
    expect(draft).toEqual({ name: 'draft', type: 'boolean', required: false });
  });

  it('Test P6: requestBody properties 被附加到 parameters[]', () => {
    const endpoints = _parseYamlStringForTesting(MINIMAL_V3_YAML, 'openapi.yaml');
    const createPost = endpoints.find((e) => e.path === '/users/{id}/posts');
    const title = createPost?.parameters?.find((p) => p.name === 'title');
    expect(title).toBeDefined();
    expect(title?.type).toBe('string');
  });

  it('Test P7: Swagger 2.0 → console.warn + 回傳空陣列', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const endpoints = _parseYamlStringForTesting(SWAGGER_V2_YAML, 'swagger.yaml');

    expect(endpoints).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Swagger 2.0'));

    warnSpy.mockRestore();
  });

  it('Test P8: 無 paths 物件 → 回傳空陣列', () => {
    const emptyV3 = 'openapi: 3.0.0\ninfo:\n  title: Empty\n  version: "1.0"';
    const endpoints = _parseYamlStringForTesting(emptyV3, 'empty.yaml');
    expect(endpoints).toHaveLength(0);
  });
});

// ─── Test Suite: 真實 inkgo 掃描 ─────────────────────────────────────────────

describe('OpenAPI Parser — 真實 inkgo 掃描', () => {
  const INKGO_DIR = '/Users/fishtv/Development/99-舊-archives/inkgo';

  it('Test R1: inkgo detect() 回傳 true', async () => {
    const result = await openapiParser.detect(INKGO_DIR);
    expect(result).toBe(true);
  });

  it('Test R2: inkgo parse() 取出 100+ endpoints（含 parameters）', async () => {
    const endpoints = await openapiParser.parse(INKGO_DIR);
    expect(endpoints.length).toBeGreaterThanOrEqual(100);

    // 確認 framework 欄位全是 openapi
    expect(endpoints.every((e) => e.framework === 'openapi')).toBe(true);

    // 確認至少有 GET 和 POST
    expect(endpoints.some((e) => e.method === 'GET')).toBe(true);
    expect(endpoints.some((e) => e.method === 'POST')).toBe(true);

    // 確認 source.file 指向 zernio-api-openapi.yaml
    expect(endpoints.every((e) => e.source.file === 'zernio-api-openapi.yaml')).toBe(true);
  }, 15000); // inkgo YAML 很大，給 15 秒
});
