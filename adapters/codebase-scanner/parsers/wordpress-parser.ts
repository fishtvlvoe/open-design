/**
 * WordPress parser — 偵測並解析 WordPress REST API 路由宣告
 *
 * 策略（PHP regex + 偽 AST）：
 * 1. detect()：
 *    - composer.json 含有 wordpress / wp-content / wp- 前綴關鍵字
 *    - 或任何 *.php 檔含有 `register_rest_route(` 呼叫
 * 2. parse()：
 *    - 用 fast-glob 掃 *.php 檔
 *    - regex 找 register_rest_route(...) 呼叫塊
 *    - 提取 namespace、route、methods、callback name
 *    - 處理三種 methods 寫法：
 *      a. 'methods' => 'GET'
 *      b. 'methods' => 'GET,POST'
 *      c. WP_REST_Server::ALLMETHODS → 展開 GET/POST/PUT/DELETE/PATCH
 *    - methods 多個時拆成多個 ApiEndpoint
 *    - path 組合：/${namespace}${route}
 *
 * 限制（v1）：
 * - namespace 僅支援字串字面量和類別常數 (self::NAMESPACE / ClassName::NAMESPACE)
 * - 用 $this->namespace 等物件屬性時，從同一檔掃描屬性賦值取值
 * - 巢狀超深或動態組合的 namespace 直接略過（warn）
 */

import { readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import fg from 'fast-glob';
import type { ApiEndpoint, HttpMethod } from '../types.ts';
import type { FrameworkParser } from '../registry.ts';
import { registerParser } from '../registry.ts';

// ─── 常數 ────────────────────────────────────────────────────────────────────

/** WP_REST_Server 常數對應的 HTTP 方法 */
const WP_REST_SERVER_CONSTANTS: Record<string, HttpMethod[]> = {
  ALLMETHODS: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  READABLE: ['GET'],
  EDITABLE: ['POST', 'PUT', 'PATCH'],
  DELETABLE: ['DELETE'],
  CREATABLE: ['POST'],
};

/** 有效的 HTTP 方法集合 */
const VALID_METHODS = new Set<HttpMethod>([
  'GET', 'POST', 'PUT', 'DELETE', 'PATCH',
]);

// ─── Detect 輔助 ──────────────────────────────────────────────────────────────

/** 嘗試讀取並解析 JSON，失敗回傳 null */
async function tryReadJson(filePath: string): Promise<unknown> {
  try {
    const raw = await readFile(filePath, 'utf-8');
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/**
 * 確認 composer.json 是否包含 WordPress 相關關鍵字
 * - name / description 含 "wordpress"
 * - type 為 "wordpress-plugin" 或 "wordpress-theme"
 * - keywords 陣列含 "wordpress"
 * - 路徑中含有 wp-content
 */
function isWordPressComposerJson(pkg: unknown): boolean {
  if (typeof pkg !== 'object' || pkg === null) return false;
  const p = pkg as Record<string, unknown>;

  // type 欄位
  const type = String(p['type'] ?? '').toLowerCase();
  if (type.startsWith('wordpress')) return true;

  // name / description
  const name = String(p['name'] ?? '').toLowerCase();
  const desc = String(p['description'] ?? '').toLowerCase();
  if (name.includes('wordpress') || name.includes('wp-') ||
      desc.includes('wordpress')) return true;

  // keywords
  const keywords = p['keywords'];
  if (Array.isArray(keywords)) {
    for (const kw of keywords) {
      if (typeof kw === 'string' && kw.toLowerCase().includes('wordpress')) {
        return true;
      }
    }
  }

  return false;
}

/** 在 PHP 原始碼字串中搜尋是否有 register_rest_route( */
function hasRegisterRestRouteCall(source: string): boolean {
  return source.includes('register_rest_route(');
}

// ─── Parse 輔助 ───────────────────────────────────────────────────────────────

/**
 * 從 PHP 原始碼提取 $this->namespace 或 $this->ns 賦值值。
 * 掃描類別屬性宣告（private $namespace = 'xxx';）
 * 或在函式外直接賦值。
 * 回傳第一個找到的值；找不到回傳 null。
 */
function extractInstanceNamespace(source: string): string | null {
  // 先找屬性宣告：private/protected/public $namespace = 'value';
  const propPattern =
    /(?:private|protected|public)\s+\$(?:namespace|ns)\s*=\s*['"]([^'"]+)['"]\s*;/g;
  const propMatch = propPattern.exec(source);
  if (propMatch !== null) {
    return propMatch[1] ?? null;
  }

  // 再找 $this->namespace = 'value'; 或 $this->ns = 'value';
  const assignPattern =
    /\$this->(?:namespace|ns)\s*=\s*['"]([^'"]+)['"]\s*;/g;
  const assignMatch = assignPattern.exec(source);
  if (assignMatch !== null) {
    return assignMatch[1] ?? null;
  }

  return null;
}

/**
 * 從 PHP 原始碼提取類別常數（self::NAMESPACE / ClassName::NAMESPACE）的值。
 * 掃描：`const NAMESPACE = 'value';` 格式宣告。
 */
function extractClassConstants(source: string): Map<string, string> {
  const constants = new Map<string, string>();
  // const CONSTNAME = 'value';
  const constPattern = /const\s+([A-Z_][A-Z0-9_]*)\s*=\s*['"]([^'"]+)['"]\s*;/g;
  let m: RegExpExecArray | null;
  while ((m = constPattern.exec(source)) !== null) {
    constants.set(m[1]!, m[2]!);
  }
  return constants;
}

/**
 * 解析 namespace 引數字串。
 * 支援：
 * - 'string-literal'
 * - "string-literal"
 * - $this->namespace / $this->ns（從 instanceNs 取）
 * - self::CONSTNAME / ClassName::CONSTNAME（從 constants 取）
 * 找不到回傳 null。
 */
function resolveNamespace(
  rawNs: string,
  instanceNs: string | null,
  constants: Map<string, string>,
): string | null {
  const trimmed = rawNs.trim();

  // 字串字面量
  const strLiteral = /^(['"])([^'"]+)\1$/.exec(trimmed);
  if (strLiteral !== null) {
    return strLiteral[2] ?? null;
  }

  // $this->namespace 或 $this->ns
  if (/^\$this->(?:namespace|ns)$/.test(trimmed)) {
    return instanceNs;
  }

  // self::CONSTNAME 或 ClassName::CONSTNAME
  const classConst = /^(?:\w+)::([A-Z_][A-Z0-9_]*)$/.exec(trimmed);
  if (classConst !== null) {
    const constName = classConst[1]!;
    return constants.get(constName) ?? null;
  }

  return null;
}

/**
 * 解析 route 引數字串（通常為字串字面量）。
 * 支援 '...' 和 "..."。
 * 回傳 null 表示無法解析。
 */
function resolveRoute(rawRoute: string): string | null {
  const trimmed = rawRoute.trim();
  const strLiteral = /^(['"])([\s\S]*?)\1$/.exec(trimmed);
  if (strLiteral !== null) {
    return strLiteral[2] ?? null;
  }
  return null;
}

/**
 * 解析 methods 字串（從 PHP 陣列中提取 'methods' => ... 的值）。
 * 支援：
 * - 'GET'
 * - 'GET,POST'
 * - 'GET, POST'（含空格）
 * - WP_REST_Server::ALLMETHODS / READABLE / EDITABLE / DELETABLE / CREATABLE
 * 回傳解析後的 HttpMethod 陣列。
 */
function parseMethods(methodsValue: string): HttpMethod[] {
  const trimmed = methodsValue.trim();

  // WP_REST_Server::CONSTANT
  const serverConst = /^WP_REST_Server::([A-Z]+)$/.exec(trimmed);
  if (serverConst !== null) {
    const constName = serverConst[1]!;
    return WP_REST_SERVER_CONSTANTS[constName] ?? [];
  }

  // 字串字面量
  const strLiteral = /^(['"])([\s\S]*?)\1$/.exec(trimmed);
  if (strLiteral !== null) {
    const raw = strLiteral[2]!;
    // 用逗號分割，trim 每個 method，過濾有效值
    const parts = raw.split(',').map((m) => m.trim().toUpperCase() as HttpMethod);
    return parts.filter((m) => VALID_METHODS.has(m));
  }

  return [];
}

// ─── 核心解析 ─────────────────────────────────────────────────────────────────

/**
 * 從 register_rest_route 呼叫塊提取所需資訊。
 *
 * PHP 呼叫形式：
 *   register_rest_route( $namespace, $route, [ ... 'methods' => '...', ... ] )
 *
 * 策略：
 * 1. 找到每個 register_rest_route( 的位置
 * 2. 提取括號內的全部原始字串（處理巢狀括號 / [ ]）
 * 3. 用 regex 從中提取 namespace、route、methods
 */
interface ParsedRoute {
  namespace: string | null;
  route: string | null;
  methods: HttpMethod[];
  line: number;
}

/** 計算字元位置對應的行號（1-based） */
function getLineNumber(source: string, charIndex: number): number {
  let line = 1;
  for (let i = 0; i < charIndex; i++) {
    if (source[i] === '\n') line++;
  }
  return line;
}

/**
 * 從 source 字串中，從 start 位置開始，找到與開頭 openChar 配對的
 * 閉合 closeChar 的位置，回傳閉合位置（含）。
 * 支援巢狀括號。
 */
function findMatchingClose(
  source: string,
  start: number,
  openChar: string,
  closeChar: string,
): number {
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let i = start;

  while (i < source.length) {
    const ch = source[i];
    const prev = i > 0 ? source[i - 1] : '';

    // 處理字串逸出
    if (prev !== '\\') {
      if (ch === "'" && !inDouble) inSingle = !inSingle;
      if (ch === '"' && !inSingle) inDouble = !inDouble;
    }

    if (!inSingle && !inDouble) {
      if (ch === openChar) depth++;
      else if (ch === closeChar) {
        depth--;
        if (depth === 0) return i;
      }
    }

    i++;
  }

  return -1; // 未找到配對
}

/**
 * 解析 PHP 檔案原始碼，回傳所有 ParsedRoute。
 */
function parsePhpSource(source: string): ParsedRoute[] {
  const routes: ParsedRoute[] = [];

  // 提取 $this->namespace / 類別常數
  const instanceNs = extractInstanceNamespace(source);
  const constants = extractClassConstants(source);

  // 搜尋所有 register_rest_route( 位置
  const callPattern = /register_rest_route\s*\(/g;
  let match: RegExpExecArray | null;

  while ((match = callPattern.exec(source)) !== null) {
    const callStart = match.index;
    const openParenPos = callStart + match[0].length - 1; // '(' 的位置
    const line = getLineNumber(source, callStart);

    // 找配對的 )
    const closeParenPos = findMatchingClose(source, openParenPos, '(', ')');
    if (closeParenPos === -1) continue;

    // 取出括號內容（不含外層括號）
    const argsRaw = source.slice(openParenPos + 1, closeParenPos);

    // 提取第一個引數（namespace）
    // 策略：取到第一個頂層逗號前
    const firstComma = findTopLevelComma(argsRaw);
    if (firstComma === -1) continue;

    const nsRaw = argsRaw.slice(0, firstComma);
    const afterFirstComma = argsRaw.slice(firstComma + 1);

    // 提取第二個引數（route）
    const secondComma = findTopLevelComma(afterFirstComma);
    if (secondComma === -1) continue;

    const routeRaw = afterFirstComma.slice(0, secondComma);

    // 第三個引數是選項陣列，從中提取 'methods'
    const optionsRaw = afterFirstComma.slice(secondComma + 1);
    const methodsValue = extractMethodsFromOptions(optionsRaw);

    const resolvedNs = resolveNamespace(nsRaw, instanceNs, constants);
    const resolvedRoute = resolveRoute(routeRaw);
    const resolvedMethods = methodsValue !== null ? parseMethods(methodsValue) : ['GET' as HttpMethod];

    routes.push({
      namespace: resolvedNs,
      route: resolvedRoute,
      methods: resolvedMethods,
      line,
    });
  }

  return routes;
}

/**
 * 在字串中找到第一個「頂層」逗號的位置。
 * 「頂層」= 不在括號 () [] {} 或字串 '' "" 內。
 * 回傳 -1 表示找不到。
 */
function findTopLevelComma(s: string): number {
  let depth = 0;
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const prev = i > 0 ? s[i - 1] : '';

    if (prev !== '\\') {
      if (ch === "'" && !inDouble) inSingle = !inSingle;
      if (ch === '"' && !inSingle) inDouble = !inDouble;
    }

    if (!inSingle && !inDouble) {
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') depth--;
      else if (ch === ',' && depth === 0) return i;
    }
  }

  return -1;
}

/**
 * 從選項陣列原始字串中提取 'methods' => ... 的值。
 * 支援：
 * - 'methods' => 'GET'
 * - "methods" => 'GET,POST'
 * - 'methods' => WP_REST_Server::ALLMETHODS
 * 回傳值（包含引號或常數參照），找不到回傳 null。
 */
function extractMethodsFromOptions(optionsRaw: string): string | null {
  // 找 'methods' => 或 "methods" =>
  const keyPattern = /['"]methods['"]\s*=>\s*/g;
  const keyMatch = keyPattern.exec(optionsRaw);
  if (keyMatch === null) return null;

  const valueStart = keyMatch.index + keyMatch[0].length;
  const valueStr = optionsRaw.slice(valueStart);

  // 值可能是字串字面量或 WP_REST_Server::XXX
  // 取到第一個頂層逗號、] 或 ) 為止
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let end = 0;

  for (let i = 0; i < valueStr.length; i++) {
    const ch = valueStr[i];
    const prev = i > 0 ? valueStr[i - 1] : '';

    if (prev !== '\\') {
      if (ch === "'" && !inDouble) inSingle = !inSingle;
      if (ch === '"' && !inSingle) inDouble = !inDouble;
    }

    if (!inSingle && !inDouble) {
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') {
        if (depth === 0) { end = i; break; }
        depth--;
      } else if (ch === ',' && depth === 0) {
        end = i;
        break;
      }
    }

    end = i + 1;
  }

  return valueStr.slice(0, end).trim();
}

// ─── FrameworkParser 實作 ─────────────────────────────────────────────────────

const wordpressParser: FrameworkParser = {
  framework: 'wordpress',

  /**
   * 偵測方式（多策略，任一成立即回傳 true）：
   * 1. composer.json 含 WordPress 特徵
   * 2. 根目錄含 wp-content/ 目錄或 wp-config.php
   * 3. 任何 *.php 含 register_rest_route( 呼叫（取樣前 50 檔）
   */
  async detect(rootDir: string): Promise<boolean> {
    // 策略 1：composer.json
    const composerPkg = await tryReadJson(join(rootDir, 'composer.json'));
    if (composerPkg !== null && isWordPressComposerJson(composerPkg)) {
      return true;
    }

    // 策略 2：wp-content/ 或 wp-config.php
    try {
      const wpFiles = await fg(
        ['wp-content/**', 'wp-config.php', 'wp-config-sample.php'],
        { cwd: rootDir, absolute: false, onlyFiles: false, deep: 1 },
      );
      if (wpFiles.length > 0) return true;
    } catch {
      // 繼續嘗試下個策略
    }

    // 策略 3：PHP 檔案含 register_rest_route（取樣 50 檔避免過慢）
    try {
      const phpFiles = await fg('**/*.php', {
        cwd: rootDir,
        absolute: true,
        ignore: ['**/vendor/**', '**/node_modules/**'],
      });
      const sample = phpFiles.slice(0, 50);

      for (const file of sample) {
        let source: string;
        try {
          source = await readFile(file, 'utf-8');
        } catch {
          continue;
        }
        if (hasRegisterRestRouteCall(source)) return true;
      }
    } catch {
      // 無法讀取 → 回傳 false
    }

    return false;
  },

  /**
   * 解析所有 *.php 檔案中的 register_rest_route 呼叫。
   */
  async parse(rootDir: string): Promise<ApiEndpoint[]> {
    let phpFiles: string[];
    try {
      phpFiles = await fg('**/*.php', {
        cwd: rootDir,
        absolute: true,
        ignore: ['**/vendor/**', '**/node_modules/**', '**/tests/**'],
      });
    } catch {
      return [];
    }

    const allEndpoints: ApiEndpoint[] = [];

    await Promise.all(
      phpFiles.map(async (filePath) => {
        let source: string;
        try {
          source = await readFile(filePath, 'utf-8');
        } catch {
          return;
        }

        if (!hasRegisterRestRouteCall(source)) return;

        const parsedRoutes = parsePhpSource(source);
        const relFile = relative(rootDir, filePath);

        for (const route of parsedRoutes) {
          if (route.namespace === null || route.route === null) {
            console.warn(
              `wordpress-parser: 無法解析 namespace 或 route，跳過 ${relFile}:${route.line}`,
            );
            continue;
          }

          if (route.methods.length === 0) {
            // 無法解析 methods，預設 GET
            route.methods = ['GET'];
          }

          // 組合路徑：/${namespace}${route}
          const nsClean = route.namespace.replace(/^\/+|\/+$/g, '');
          const routeClean = route.route.replace(/^\/+/, '');
          const fullPath = `/${nsClean}/${routeClean}`.replace(/\/+$/, '') || '/';

          for (const method of route.methods) {
            allEndpoints.push({
              method,
              path: fullPath,
              source: { file: relFile, line: route.line },
              framework: 'wordpress',
            });
          }
        }
      }),
    );

    // 依 method + path 去重
    const seen = new Set<string>();
    return allEndpoints.filter((ep) => {
      const key = `${ep.method}:${ep.path}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  },
};

// ─── 自動註冊 ─────────────────────────────────────────────────────────────────

registerParser(wordpressParser);

// ─── 匯出（供測試直接使用）─────────────────────────────────────────────────────

export { wordpressParser };

/**
 * 供測試使用的內部函式
 */
export { parsePhpSource, parseMethods, resolveNamespace, extractClassConstants };
