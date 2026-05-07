/**
 * nextjs-parser 單元測試
 *
 * 覆蓋範圍：
 * - detect(): package.json 有 next + app/api/ 目錄 → true
 * - detect(): 沒有 next dependency → false
 * - detect(): 有 next 但沒有 app/api/ → false
 * - _filePathToApiPath(): 靜態路徑、動態段 [id]、catch-all [...slug]
 * - _parseRouteFileForTesting(): function 宣告、const 宣告、specifier export、re-export
 * - parse(): 完整掃描 fixture 目錄
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  nextjsParser,
  _parseRouteFileForTesting,
  _filePathToApiPathForTesting,
} from '../parsers/nextjs-parser.ts';

// ─── 測試輔助 ────────────────────────────────────────────────────────────────

async function makeTmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'od-nextjs-test-'));
}

async function writePackageJson(dir: string, deps: Record<string, string>): Promise<void> {
  await writeFile(join(dir, 'package.json'), JSON.stringify({ dependencies: deps }));
}

async function makeApiDir(dir: string): Promise<void> {
  await mkdir(join(dir, 'app', 'api'), { recursive: true });
}

async function writeRouteFile(dir: string, apiPath: string, content: string): Promise<void> {
  const fullDir = join(dir, 'app', 'api', apiPath);
  await mkdir(fullDir, { recursive: true });
  await writeFile(join(fullDir, 'route.ts'), content);
}

// ─── detect() ────────────────────────────────────────────────────────────────

describe('Next.js Parser — detect()', () => {
  let tmpDir: string;

  beforeEach(async () => { tmpDir = await makeTmpDir(); });
  afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

  it('Test D1: 有 next dep + app/api/ 目錄 → true', async () => {
    await writePackageJson(tmpDir, { next: '^14.0.0' });
    await makeApiDir(tmpDir);
    expect(await nextjsParser.detect(tmpDir)).toBe(true);
  });

  it('Test D2: 沒有 next dep → false', async () => {
    await writePackageJson(tmpDir, { express: '^4.0.0' });
    await makeApiDir(tmpDir);
    expect(await nextjsParser.detect(tmpDir)).toBe(false);
  });

  it('Test D3: 有 next dep 但沒有 app/api/ → false', async () => {
    await writePackageJson(tmpDir, { next: '^14.0.0' });
    // 不建 app/api/
    expect(await nextjsParser.detect(tmpDir)).toBe(false);
  });

  it('Test D4: 無 package.json → false', async () => {
    expect(await nextjsParser.detect(tmpDir)).toBe(false);
  });
});

// ─── _filePathToApiPath() ────────────────────────────────────────────────────

describe('Next.js Parser — filePathToApiPath()', () => {
  it('Test P1: 靜態路徑', () => {
    expect(_filePathToApiPathForTesting('app/api/chat/message/route.ts'))
      .toBe('/api/chat/message');
  });

  it('Test P2: 動態段 [id]', () => {
    expect(_filePathToApiPathForTesting('app/api/notifications/[id]/read/route.ts'))
      .toBe('/api/notifications/[id]/read');
  });

  it('Test P3: catch-all [...nextauth]', () => {
    expect(_filePathToApiPathForTesting('app/api/auth/[...nextauth]/route.ts'))
      .toBe('/api/auth/[...nextauth]');
  });

  it('Test P4: 根路由', () => {
    expect(_filePathToApiPathForTesting('app/api/route.ts'))
      .toBe('/api');
  });

  it('Test P5: 巢狀靜態路徑', () => {
    expect(_filePathToApiPathForTesting('app/api/settings/notifications/route.ts'))
      .toBe('/api/settings/notifications');
  });
});

// ─── _parseRouteFileForTesting() ─────────────────────────────────────────────

describe('Next.js Parser — parseRouteFile()', () => {
  let tmpDir: string;

  beforeEach(async () => { tmpDir = await makeTmpDir(); });
  afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

  async function writeAndParse(content: string): Promise<string[]> {
    const filePath = join(tmpDir, 'route.ts');
    await writeFile(filePath, content);
    const methods = await _parseRouteFileForTesting(filePath);
    return methods.sort();
  }

  it('Test R1: export async function GET/POST', async () => {
    const methods = await writeAndParse(`
      import { NextResponse } from 'next/server';
      export async function GET(request: Request) {
        return NextResponse.json({ ok: true });
      }
      export async function POST(request: Request) {
        return NextResponse.json({ ok: true });
      }
    `);
    expect(methods).toEqual(['GET', 'POST']);
  });

  it('Test R2: export const GET = async (...) => ...', async () => {
    const methods = await writeAndParse(`
      export const GET = async (req: Request) => {
        return new Response('ok');
      };
      export const DELETE = async () => new Response('deleted');
    `);
    expect(methods).toEqual(['DELETE', 'GET']);
  });

  it('Test R3: export { handler as GET, handler as POST }', async () => {
    const methods = await writeAndParse(`
      import NextAuth from 'next-auth';
      import { authOptions } from '@/lib/auth';
      const handler = NextAuth(authOptions);
      export { handler as GET, handler as POST };
    `);
    expect(methods).toEqual(['GET', 'POST']);
  });

  it('Test R4: re-export from 另一個模組', async () => {
    const methods = await writeAndParse(`
      export { POST } from '../chat/insight/route';
    `);
    expect(methods).toEqual(['POST']);
  });

  it('Test R5: PUT + PATCH', async () => {
    const methods = await writeAndParse(`
      export function PUT(req: Request) { return new Response('ok'); }
      export function PATCH(req: Request) { return new Response('ok'); }
    `);
    expect(methods).toEqual(['PATCH', 'PUT']);
  });

  it('Test R6: 非 HTTP 方法 export 忽略', async () => {
    const methods = await writeAndParse(`
      export const runtime = 'edge';
      export function GET(req: Request) { return new Response('ok'); }
      export const dynamic = 'force-dynamic';
    `);
    expect(methods).toEqual(['GET']);
  });

  it('Test R7: 空檔案 → 空陣列', async () => {
    const methods = await writeAndParse('');
    expect(methods).toEqual([]);
  });
});

// ─── parse() 完整掃描 ─────────────────────────────────────────────────────────

describe('Next.js Parser — parse() 完整掃描', () => {
  let tmpDir: string;

  beforeEach(async () => { tmpDir = await makeTmpDir(); });
  afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

  it('Test F1: 掃描 fixture 目錄，回傳正確 endpoints', async () => {
    await writePackageJson(tmpDir, { next: '^14.0.0' });

    // 建立 fixture routes
    await writeRouteFile(tmpDir, 'users', `
      export async function GET(req: Request) { return new Response('ok'); }
      export async function POST(req: Request) { return new Response('ok'); }
    `);

    await writeRouteFile(tmpDir, 'users/[id]', `
      export async function GET(req: Request) { return new Response('ok'); }
      export async function PUT(req: Request) { return new Response('ok'); }
      export async function DELETE(req: Request) { return new Response('ok'); }
    `);

    await writeRouteFile(tmpDir, 'auth/[...nextauth]', `
      const handler = {};
      export { handler as GET, handler as POST };
    `);

    const endpoints = await nextjsParser.parse(tmpDir);

    // 驗證數量（3 路由 × 合計 7 個 method 宣告）
    expect(endpoints.length).toBe(7);

    // 驗證路徑格式
    const paths = new Set(endpoints.map((e) => e.path));
    expect(paths).toContain('/api/users');
    expect(paths).toContain('/api/users/[id]');
    expect(paths).toContain('/api/auth/[...nextauth]');

    // 驗證 framework 標記
    for (const ep of endpoints) {
      expect(ep.framework).toBe('nextjs');
    }
  });

  it('Test F2: app/api/ 目錄不存在 → 回傳空陣列', async () => {
    await writePackageJson(tmpDir, { next: '^14.0.0' });
    // 不建 app/api/
    const endpoints = await nextjsParser.parse(tmpDir);
    expect(endpoints).toEqual([]);
  });

  it('Test F3: 動態路由 [id] 保留原樣', async () => {
    await writePackageJson(tmpDir, { next: '^14.0.0' });
    await writeRouteFile(tmpDir, 'posts/[id]/comments', `
      export async function GET() { return new Response('ok'); }
    `);

    const endpoints = await nextjsParser.parse(tmpDir);
    expect(endpoints[0]?.path).toBe('/api/posts/[id]/comments');
  });
});
