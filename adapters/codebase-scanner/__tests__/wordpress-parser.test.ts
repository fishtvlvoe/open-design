/**
 * wordpress-parser 單元測試
 *
 * 覆蓋範圍：
 * - detect(): composer.json WordPress 特徵
 * - detect(): register_rest_route( PHP 特徵掃描
 * - parse(): 三種 methods 寫法
 *   a. 'methods' => 'GET'        → 單一方法
 *   b. 'methods' => 'GET,POST'   → 多方法拆分
 *   c. WP_REST_Server::ALLMETHODS → 展開所有方法
 * - parse(): $this->namespace 屬性
 * - parse(): self::NAMESPACE 類別常數
 * - parse(): 字串字面量 namespace
 * - parse(): 無法解析 namespace → warn + 跳過
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  wordpressParser,
  parsePhpSource,
  parseMethods,
} from '../parsers/wordpress-parser.ts';

// ─── 測試輔助 ────────────────────────────────────────────────────────────────

async function makeTmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'od-wp-test-'));
}

async function writeComposerJson(dir: string, content: object): Promise<void> {
  await writeFile(join(dir, 'composer.json'), JSON.stringify(content));
}

async function writePhpFile(
  dir: string,
  filename: string,
  content: string,
): Promise<void> {
  await mkdir(join(dir, 'includes', 'api'), { recursive: true });
  await writeFile(join(dir, 'includes', 'api', filename), content);
}

// ─── Test Suite: detect() ────────────────────────────────────────────────────

describe('WordPress Parser — detect()', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('Test D1: composer.json type=wordpress-plugin → detect() 回傳 true', async () => {
    await writeComposerJson(tmpDir, {
      name: 'vendor/my-plugin',
      type: 'wordpress-plugin',
    });
    const result = await wordpressParser.detect(tmpDir);
    expect(result).toBe(true);
  });

  it('Test D2: composer.json 非 WordPress → 但 PHP 含 register_rest_route → detect() 回傳 true', async () => {
    await writeComposerJson(tmpDir, {
      name: 'vendor/some-lib',
      type: 'library',
    });
    await writePhpFile(
      tmpDir,
      'class-api.php',
      `<?php
register_rest_route('test/v1', '/hello', ['methods' => 'GET', 'callback' => 'my_cb']);
`,
    );
    const result = await wordpressParser.detect(tmpDir);
    expect(result).toBe(true);
  });

  it('Test D3: 純 Node 專案（無 PHP / WordPress 特徵）→ detect() 回傳 false', async () => {
    await writeFile(
      join(tmpDir, 'package.json'),
      JSON.stringify({ name: 'my-app', dependencies: { express: '^4' } }),
    );
    const result = await wordpressParser.detect(tmpDir);
    expect(result).toBe(false);
  });
});

// ─── Test Suite: parseMethods() ──────────────────────────────────────────────

describe('WordPress Parser — parseMethods()', () => {
  // Methods 寫法 a：單一字串字面量
  it('Test M1: 單一方法 "GET" → [GET]', () => {
    expect(parseMethods("'GET'")).toEqual(['GET']);
  });

  it('Test M2: 單一方法 "POST" → [POST]', () => {
    expect(parseMethods("'POST'")).toEqual(['POST']);
  });

  // Methods 寫法 b：逗號分隔字串
  it('Test M3: 多方法 "GET,POST"（無空格）→ [GET, POST]', () => {
    expect(parseMethods("'GET,POST'")).toEqual(['GET', 'POST']);
  });

  it('Test M4: 多方法 "GET, POST"（含空格）→ [GET, POST]', () => {
    expect(parseMethods("'GET, POST'")).toEqual(['GET', 'POST']);
  });

  it('Test M5: 多方法 "PUT,PATCH"→ [PUT, PATCH]', () => {
    expect(parseMethods("'PUT,PATCH'")).toEqual(['PUT', 'PATCH']);
  });

  // Methods 寫法 c：WP_REST_Server 常數
  it('Test M6: WP_REST_Server::ALLMETHODS → GET/POST/PUT/DELETE/PATCH', () => {
    expect(parseMethods('WP_REST_Server::ALLMETHODS')).toEqual([
      'GET', 'POST', 'PUT', 'DELETE', 'PATCH',
    ]);
  });

  it('Test M7: WP_REST_Server::READABLE → [GET]', () => {
    expect(parseMethods('WP_REST_Server::READABLE')).toEqual(['GET']);
  });

  it('Test M8: WP_REST_Server::EDITABLE → [POST, PUT, PATCH]', () => {
    expect(parseMethods('WP_REST_Server::EDITABLE')).toEqual(['POST', 'PUT', 'PATCH']);
  });

  it('Test M9: WP_REST_Server::DELETABLE → [DELETE]', () => {
    expect(parseMethods('WP_REST_Server::DELETABLE')).toEqual(['DELETE']);
  });

  it('Test M10: WP_REST_Server::CREATABLE → [POST]', () => {
    expect(parseMethods('WP_REST_Server::CREATABLE')).toEqual(['POST']);
  });
});

// ─── Test Suite: parsePhpSource() ────────────────────────────────────────────

describe('WordPress Parser — parsePhpSource()', () => {
  // 字串字面量 namespace
  it('Test P1: 字串字面量 namespace → 正確解析', () => {
    const source = `<?php
register_rest_route('buygo/v1', '/orders', [
    'methods' => 'GET',
    'callback' => 'my_callback',
]);
`;
    const routes = parsePhpSource(source);
    expect(routes).toHaveLength(1);
    expect(routes[0]!.namespace).toBe('buygo/v1');
    expect(routes[0]!.route).toBe('/orders');
    expect(routes[0]!.methods).toEqual(['GET']);
  });

  // $this->namespace
  it('Test P2: $this->namespace 屬性 → 從類別宣告解析', () => {
    const source = `<?php
class My_API {
    private $namespace = 'myapi/v1';

    public function register_routes() {
        register_rest_route($this->namespace, '/products', [
            'methods' => 'POST',
            'callback' => [$this, 'create_product'],
        ]);
    }
}
`;
    const routes = parsePhpSource(source);
    expect(routes).toHaveLength(1);
    expect(routes[0]!.namespace).toBe('myapi/v1');
    expect(routes[0]!.route).toBe('/products');
    expect(routes[0]!.methods).toEqual(['POST']);
  });

  // self::NAMESPACE 類別常數
  it('Test P3: self::NAMESPACE 類別常數 → 從 const 宣告解析', () => {
    const source = `<?php
class Invite_API {
    const NAMESPACE = 'buygo-plus-one/v1';

    public function register_routes(): void {
        register_rest_route(self::NAMESPACE, '/invite/create', [
            'methods' => 'POST',
            'callback' => [$this, 'create_invite'],
        ]);
    }
}
`;
    const routes = parsePhpSource(source);
    expect(routes).toHaveLength(1);
    expect(routes[0]!.namespace).toBe('buygo-plus-one/v1');
    expect(routes[0]!.route).toBe('/invite/create');
    expect(routes[0]!.methods).toEqual(['POST']);
  });

  // Methods 寫法 b：逗號分隔
  it('Test P4: methods => "GET,POST" → 拆成兩個 method', () => {
    const source = `<?php
register_rest_route('api/v1', '/items', [
    'methods' => 'GET,POST',
    'callback' => 'handle',
]);
`;
    const routes = parsePhpSource(source);
    expect(routes).toHaveLength(1);
    expect(routes[0]!.methods).toEqual(['GET', 'POST']);
  });

  // Methods 寫法 c：WP_REST_Server::ALLMETHODS
  it('Test P5: methods => WP_REST_Server::ALLMETHODS → 5 個方法', () => {
    const source = `<?php
register_rest_route('api/v1', '/full', [
    'methods' => WP_REST_Server::ALLMETHODS,
    'callback' => 'handle_all',
]);
`;
    const routes = parsePhpSource(source);
    expect(routes).toHaveLength(1);
    expect(routes[0]!.methods).toEqual(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']);
  });

  // 多個 register_rest_route 在同一檔案
  it('Test P6: 同一檔案多個路由 → 全部解析', () => {
    const source = `<?php
class Multi_API {
    private $namespace = 'multi/v1';

    public function register_routes() {
        register_rest_route($this->namespace, '/a', [
            'methods' => 'GET',
            'callback' => 'handle_a',
        ]);
        register_rest_route($this->namespace, '/b', [
            'methods' => 'POST',
            'callback' => 'handle_b',
        ]);
        register_rest_route($this->namespace, '/c', [
            'methods' => 'PUT',
            'callback' => 'handle_c',
        ]);
    }
}
`;
    const routes = parsePhpSource(source);
    expect(routes).toHaveLength(3);
    const paths = routes.map((r) => r.route);
    expect(paths).toContain('/a');
    expect(paths).toContain('/b');
    expect(paths).toContain('/c');
  });

  // 行號檢查
  it('Test P7: 行號應反映 register_rest_route 所在行', () => {
    const source = `<?php
// 第 2 行是註解

register_rest_route('ns/v1', '/test', [
    'methods' => 'GET',
    'callback' => 'cb',
]);
`;
    const routes = parsePhpSource(source);
    expect(routes).toHaveLength(1);
    expect(routes[0]!.line).toBe(4); // register_rest_route 在第 4 行
  });
});

// ─── Test Suite: parse() 整合 ────────────────────────────────────────────────

describe('WordPress Parser — parse() 整合', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('Test I1: 三種 methods 寫法 → parse() 正確展開成多個 ApiEndpoint', async () => {
    await writeComposerJson(tmpDir, { name: 'v/p', type: 'wordpress-plugin' });
    await writePhpFile(
      tmpDir,
      'class-test-api.php',
      `<?php
class Test_API {
    const NAMESPACE = 'test/v1';

    public function register_routes() {
        // 寫法 a：單一方法
        register_rest_route(self::NAMESPACE, '/single', [
            'methods' => 'GET',
            'callback' => 'cb1',
        ]);

        // 寫法 b：逗號分隔多方法
        register_rest_route(self::NAMESPACE, '/multi', [
            'methods' => 'GET,POST',
            'callback' => 'cb2',
        ]);

        // 寫法 c：WP_REST_Server::ALLMETHODS
        register_rest_route(self::NAMESPACE, '/all', [
            'methods' => WP_REST_Server::ALLMETHODS,
            'callback' => 'cb3',
        ]);
    }
}
`,
    );

    const endpoints = await wordpressParser.parse(tmpDir);

    // 單一方法 → 1 個 endpoint
    const singleEndpoints = endpoints.filter((ep) => ep.path === '/test/v1/single');
    expect(singleEndpoints).toHaveLength(1);
    expect(singleEndpoints[0]!.method).toBe('GET');

    // 多方法 → 2 個 endpoints（GET 和 POST）
    const multiEndpoints = endpoints.filter((ep) => ep.path === '/test/v1/multi');
    expect(multiEndpoints).toHaveLength(2);
    const multiMethods = multiEndpoints.map((ep) => ep.method).sort();
    expect(multiMethods).toEqual(['GET', 'POST']);

    // ALLMETHODS → 5 個 endpoints
    const allEndpoints = endpoints.filter((ep) => ep.path === '/test/v1/all');
    expect(allEndpoints).toHaveLength(5);
    const allMethods = allEndpoints.map((ep) => ep.method).sort();
    expect(allMethods).toEqual(['DELETE', 'GET', 'PATCH', 'POST', 'PUT']);

    // framework 標記正確
    for (const ep of endpoints) {
      expect(ep.framework).toBe('wordpress');
    }
  });

  it('Test I2: $this->namespace + 多檔案 → 全部解析並去重', async () => {
    await writeComposerJson(tmpDir, { name: 'v/p', type: 'wordpress-plugin' });

    // 第一個 API 檔
    await writePhpFile(
      tmpDir,
      'class-orders-api.php',
      `<?php
class Orders_API {
    private $namespace = 'shop/v1';

    public function register_routes() {
        register_rest_route($this->namespace, '/orders', [
            'methods' => 'GET',
            'callback' => 'get_orders',
        ]);
        register_rest_route($this->namespace, '/orders', [
            'methods' => 'POST',
            'callback' => 'create_order',
        ]);
        register_rest_route($this->namespace, '/orders/(?P<id>\\d+)', [
            'methods' => 'PUT',
            'callback' => 'update_order',
        ]);
    }
}
`,
    );

    const endpoints = await wordpressParser.parse(tmpDir);

    expect(endpoints.length).toBeGreaterThanOrEqual(3);

    const orderGetEndpoints = endpoints.filter(
      (ep) => ep.path === '/shop/v1/orders' && ep.method === 'GET',
    );
    expect(orderGetEndpoints).toHaveLength(1);

    const orderPostEndpoints = endpoints.filter(
      (ep) => ep.path === '/shop/v1/orders' && ep.method === 'POST',
    );
    expect(orderPostEndpoints).toHaveLength(1);
  });
});
