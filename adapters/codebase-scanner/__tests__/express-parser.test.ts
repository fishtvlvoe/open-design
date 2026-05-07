/**
 * express-parser 單元測試
 *
 * 覆蓋範圍：
 * - detect(): package.json 有 / 沒有 express
 * - parse(): 頂層 app.METHOD() 呼叫
 * - parse(): app.use(prefix, router) + router.METHOD() 巢狀一層
 * - parse(): 巢狀超過一層 → console.warn
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { expressParser, _parseFileForTesting } from '../parsers/express-parser.ts';

// ─── 測試輔助 ────────────────────────────────────────────────────────────────

async function makeTmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'od-express-test-'));
}

async function writePackageJson(dir: string, hasDep: boolean): Promise<void> {
  const pkg = hasDep
    ? { dependencies: { express: '^4.18.0' } }
    : { dependencies: { fastify: '^4.0.0' } };
  await writeFile(join(dir, 'package.json'), JSON.stringify(pkg));
}

// ─── Test Suite ──────────────────────────────────────────────────────────────

describe('Express Parser — detect()', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('Test D1: package.json 有 express → detect() 回傳 true', async () => {
    await writePackageJson(tmpDir, true);
    const result = await expressParser.detect(tmpDir);
    expect(result).toBe(true);
  });

  it('Test D2: package.json 沒有 express → detect() 回傳 false', async () => {
    await writePackageJson(tmpDir, false);
    const result = await expressParser.detect(tmpDir);
    expect(result).toBe(false);
  });
});

describe('Express Parser — parse() 用 fixture 字串', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('Test P1: 頂層 app.METHOD() 呼叫 → 正確解析 endpoint', async () => {
    // 固定字串 fixture：直接用 app.post / app.get 宣告
    const fixture = `
import express from 'express';
const app = express();

app.post('/api/publish', async (req, res) => {
  res.json({ ok: true });
});

app.get('/api/status', (req, res) => {
  res.json({ status: 'ok' });
});
`;
    const filePath = join(tmpDir, 'server.ts');
    await writeFile(filePath, fixture, 'utf-8');

    const endpoints = await _parseFileForTesting(filePath, tmpDir);

    expect(endpoints.length).toBe(2);

    const post = endpoints.find((e) => e.method === 'POST');
    expect(post).toBeDefined();
    expect(post?.path).toBe('/api/publish');
    expect(post?.framework).toBe('express');
    expect(post?.source.file).toBe('server.ts');

    const get = endpoints.find((e) => e.method === 'GET');
    expect(get).toBeDefined();
    expect(get?.path).toBe('/api/status');
  });

  it('Test P2: app.use(prefix, router) 一層巢狀 → 組合路徑正確', async () => {
    // Fixture：模擬 FlowGo 的 router 模式
    const fixture = `
import { Router } from 'express';
const publishRouter = Router();

publishRouter.post('/schedule', (req, res) => {
  res.json({ ok: true });
});

publishRouter.get('/history', (req, res) => {
  res.json({ ok: true });
});

const app = express();
app.use('/api', publishRouter);
`;
    const filePath = join(tmpDir, 'app.ts');
    await writeFile(filePath, fixture, 'utf-8');

    const endpoints = await _parseFileForTesting(filePath, tmpDir);

    expect(endpoints.length).toBeGreaterThanOrEqual(2);

    const post = endpoints.find((e) => e.method === 'POST' && e.path === '/api/schedule');
    expect(post).toBeDefined();
    expect(post?.framework).toBe('express');

    const get = endpoints.find((e) => e.method === 'GET' && e.path === '/api/history');
    expect(get).toBeDefined();
  });
});

describe('Express Parser — 巢狀 router 超過 depth=1', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('Test N1: router1.use(prefix, router2) → 呼叫 console.warn 並跳過 endpoint', async () => {
    // 合成 fixture：router1 是已知 mount，然後 router1.use(prefix, router2) 觸發 depth>1 警告
    const fixture = `
import { Router } from 'express';
const router1 = Router();
const router2 = Router();

// app → router1（depth=1，合法）
const app = express();
app.use('/api', router1);

// router1 → router2（depth=2，超過限制）
router1.use('/v1', router2);

// router2 的路由 → depth=3，不應被發出
router2.post('/foo', (req, res) => {
  res.json({ ok: true });
});
`;
    const filePath = join(tmpDir, 'nested.ts');
    await writeFile(filePath, fixture, 'utf-8');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const endpoints = await _parseFileForTesting(filePath, tmpDir);

    // 應有 warn 被呼叫，訊息含 'nested router beyond depth 1'
    expect(warnSpy).toHaveBeenCalled();
    const warnMsg = warnSpy.mock.calls[0]?.[0] as string;
    expect(warnMsg).toContain('nested router beyond depth 1');

    // router2.post('/foo') 不在已知 mount 清單 → 不發出 endpoint
    const fooEndpoint = endpoints.find((e) => e.path.includes('/foo'));
    expect(fooEndpoint).toBeUndefined();

    warnSpy.mockRestore();
  });
});
