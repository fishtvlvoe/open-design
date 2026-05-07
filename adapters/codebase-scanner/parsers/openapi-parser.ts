/**
 * OpenAPI parser — 偵測並解析 OpenAPI 3.x 規格檔案（YAML / JSON）
 *
 * 策略：
 * 1. detect()：以 fast-glob 找 *.yaml / *.yml / *.json，
 *    讀前幾行確認含 `openapi: 3.` 或 `"openapi": "3.` 特徵字串
 * 2. parse()：以 fast-glob 找常見 OpenAPI 檔名模式，
 *    用 js-yaml 讀入（JSON 也適用），解析 paths.*
 *    - 每個 path + method 組合產出一個 ApiEndpoint
 *    - parameters（query / path / header）與 requestBody 欄位一同解析
 *    - swagger 2.0（`swagger: "2.0"`）→ console.warn + 跳過
 *
 * 限制（v1）：
 * - 不處理 $ref 解析（components 引用保留原始型別字串）
 * - 不支援 OpenAPI 3.1 webhook（非 paths 的 endpoint 類型）
 */

import { readFile } from 'node:fs/promises';
import { relative } from 'node:path';
import fg from 'fast-glob';
import yaml from 'js-yaml';
import type { ApiEndpoint, HttpMethod } from '../types.ts';
import type { FrameworkParser } from '../registry.ts';
import { registerParser } from '../registry.ts';
import { maybeCachedParse } from '../cache.ts';

/** Wave 7：cache namespace */
const CACHE_NAMESPACE = 'openapi-doc';

// ─── 常數 ────────────────────────────────────────────────────────────────────

/** 支援的 HTTP method（OpenAPI spec 定義的 path item methods） */
const HTTP_METHODS: ReadonlySet<string> = new Set([
  'get', 'post', 'put', 'delete', 'patch', 'options', 'head',
]);

/** OpenAPI 3.x 特徵字串（detect 用，避免載入整份文件） */
const OPENAPI_V3_PATTERNS = [
  /openapi:\s*['"]?3\./,        // YAML 格式
  /"openapi"\s*:\s*"3\./,       // JSON 格式
];

/** Swagger 2.0 特徵字串 */
const SWAGGER_V2_PATTERNS = [
  /swagger:\s*['"]?2\./,
  /"swagger"\s*:\s*"2\./,
];

/** fast-glob 掃描 OpenAPI 規格檔的 glob 模式 */
const OPENAPI_GLOBS = [
  // 根目錄常見命名
  'openapi.{yaml,yml,json}',
  'openapi-spec.{yaml,yml,json}',
  'swagger.{yaml,yml,json}',
  // 任意子目錄的 *.openapi.* 或 *swagger* 或 *openapi*
  '**/*.openapi.{yaml,yml,json}',
  '**/*swagger*.{yaml,yml,json}',
  '**/*openapi*.{yaml,yml,json}',
];

const GLOB_IGNORE = [
  '**/node_modules/**',
  '**/dist/**',
  '**/.next/**',
  '**/build/**',
  '**/.git/**',
];

/** detect() 掃描候選檔案時的 glob 模式 */
const DETECT_GLOBS = [
  '**/*.{yaml,yml,json}',
];

// ─── 型別（OpenAPI 文件的局部結構） ─────────────────────────────────────────

interface OpenApiParameter {
  name: string;
  in: 'query' | 'path' | 'header' | 'cookie';
  required?: boolean;
  schema?: {
    type?: string;
    $ref?: string;
  };
}

interface OpenApiRequestBodyContent {
  schema?: {
    type?: string;
    $ref?: string;
    properties?: Record<string, { type?: string }>;
  };
}

interface OpenApiOperation {
  parameters?: OpenApiParameter[];
  requestBody?: {
    required?: boolean;
    content?: Record<string, OpenApiRequestBodyContent>;
  };
}

interface OpenApiDocument {
  openapi?: string;
  swagger?: string;
  paths?: Record<string, Record<string, OpenApiOperation>>;
}

// ─── 輔助函式 ─────────────────────────────────────────────────────────────────

/**
 * 讀取檔案的前 1 KB（不需載入整份 YAML），判斷是否為 OpenAPI 3.x
 */
async function isOpenApiV3File(filePath: string): Promise<boolean> {
  try {
    const raw = await readFile(filePath, 'utf-8');
    const head = raw.slice(0, 1024);

    // 先排除 swagger 2.0
    if (SWAGGER_V2_PATTERNS.some((p) => p.test(head))) {
      return false;
    }
    return OPENAPI_V3_PATTERNS.some((p) => p.test(head));
  } catch {
    return false;
  }
}

/**
 * 讀取並用 js-yaml 解析 YAML / JSON 檔案
 * 遇到解析錯誤回傳 null（不拋出）
 */
async function loadYamlOrJson(filePath: string): Promise<unknown> {
  try {
    const raw = await readFile(filePath, 'utf-8');
    return yaml.load(raw);
  } catch {
    return null;
  }
}

/**
 * 從 OpenAPI document 的 paths 物件擷取 endpoints
 */
function extractEndpoints(
  doc: OpenApiDocument,
  relFile: string,
): ApiEndpoint[] {
  const paths = doc.paths ?? {};
  const endpoints: ApiEndpoint[] = [];

  for (const [routePath, pathItem] of Object.entries(paths)) {
    if (typeof pathItem !== 'object' || pathItem === null) continue;

    for (const [method, operation] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method.toLowerCase())) continue;
      if (typeof operation !== 'object' || operation === null) continue;

      const httpMethod = method.toUpperCase() as HttpMethod;
      const op = operation as OpenApiOperation;

      // 解析 parameters（query + path + header，忽略 cookie）
      const parameters: ApiEndpoint['parameters'] = [];

      if (Array.isArray(op.parameters)) {
        for (const param of op.parameters) {
          if (typeof param !== 'object' || param === null) continue;
          const p = param as OpenApiParameter;
          if (p.in === 'cookie') continue; // 忽略 cookie 參數

          // 決定型別：優先用 schema.type，其次用 $ref 縮寫
          let paramType = 'string';
          if (p.schema?.type) {
            paramType = p.schema.type;
          } else if (p.schema?.$ref) {
            // 取 $ref 最後一段（e.g. #/components/schemas/UserId → UserId）
            const parts = p.schema.$ref.split('/');
            paramType = parts[parts.length - 1] ?? 'object';
          }

          parameters.push({
            name: p.name,
            type: paramType,
            required: p.required ?? (p.in === 'path'), // path 參數預設 required
          });
        }
      }

      // 解析 requestBody（取第一個 content type 的 schema.properties）
      if (op.requestBody?.content) {
        const contentEntries = Object.entries(op.requestBody.content);
        const firstContent = contentEntries[0];
        if (firstContent) {
          const [, contentValue] = firstContent;
          const schema = (contentValue as OpenApiRequestBodyContent).schema;
          if (schema?.properties) {
            for (const [propName, propSchema] of Object.entries(schema.properties)) {
              parameters.push({
                name: propName,
                type: propSchema.type ?? 'string',
                required: op.requestBody.required ?? false,
              });
            }
          }
        }
      }

      endpoints.push({
        method: httpMethod,
        path: routePath,
        source: {
          file: relFile,
          line: 1, // OpenAPI 規格沒有行號，固定為 1
        },
        framework: 'openapi',
        ...(parameters.length > 0 ? { parameters } : {}),
      });
    }
  }

  return endpoints;
}

/**
 * 判斷已解析的物件是否為 OpenAPI 3.x 文件
 */
function isOpenApiV3Doc(doc: unknown): doc is OpenApiDocument {
  if (typeof doc !== 'object' || doc === null) return false;
  const d = doc as Record<string, unknown>;
  return typeof d['openapi'] === 'string' && d['openapi'].startsWith('3.');
}

/**
 * 判斷已解析的物件是否為 Swagger 2.0 文件
 */
function isSwaggerV2Doc(doc: unknown): boolean {
  if (typeof doc !== 'object' || doc === null) return false;
  const d = doc as Record<string, unknown>;
  return typeof d['swagger'] === 'string' && d['swagger'].startsWith('2.');
}

// ─── FrameworkParser 實作 ─────────────────────────────────────────────────────


// ─── Wave 7：per-file 解析 helper（供 cache wrapper 呼叫） ─────────────────

/**
 * 解析單一 OpenAPI 檔，回傳 ApiEndpoint[]。
 * 非 OpenAPI 3.x 文件回傳空陣列；Swagger 2.0 印 warn 並回空陣列。
 */
async function parseSingleOpenApiFile(
  filePath: string,
  rootDir: string,
): Promise<ApiEndpoint[]> {
  const doc = await loadYamlOrJson(filePath);
  const relFile = relative(rootDir, filePath);

  if (isSwaggerV2Doc(doc)) {
    console.warn(
      `openapi-parser: skipped ${relFile} (Swagger 2.0 not supported, use OpenAPI 3.x)`,
    );
    return [];
  }

  if (!isOpenApiV3Doc(doc)) return [];

  return extractEndpoints(doc, relFile);
}

const openapiParser: FrameworkParser = {
  framework: 'openapi',

  /**
   * 偵測方式：掃描根目錄所有 yaml/yml/json，
   * 讀前 1 KB 確認有 `openapi: 3.` 特徵字串。
   * 找到至少一個符合條件的檔案即回傳 true。
   */
  async detect(rootDir: string): Promise<boolean> {
    let candidates: string[];
    try {
      candidates = await fg(DETECT_GLOBS, {
        cwd: rootDir,
        absolute: true,
        ignore: GLOB_IGNORE,
      });
    } catch {
      return false;
    }

    for (const filePath of candidates) {
      if (await isOpenApiV3File(filePath)) {
        return true;
      }
    }

    return false;
  },

  /**
   * 解析方式：
   * 1. 用常見 OpenAPI 檔名 glob 找候選檔案
   * 2. 用 js-yaml 讀入
   * 3. 確認是 OpenAPI 3.x（否則 warn 並跳過）
   * 4. 解析 paths.* 取出所有 method + path 組合
   */
  async parse(rootDir: string): Promise<ApiEndpoint[]> {
    let candidates: string[];
    try {
      candidates = await fg(OPENAPI_GLOBS, {
        cwd: rootDir,
        absolute: true,
        ignore: GLOB_IGNORE,
        unique: true,
      });
    } catch {
      return [];
    }

    // Wave 7：每檔解析結果走 mtime cache
    const perFileResults = await Promise.all(
      candidates.map((filePath) =>
        maybeCachedParse<ApiEndpoint[]>(
          filePath,
          CACHE_NAMESPACE,
          () => parseSingleOpenApiFile(filePath, rootDir),
        ),
      ),
    );

    const allEndpoints: ApiEndpoint[] = [];
    for (const eps of perFileResults) {
      allEndpoints.push(...eps);
    }

    return allEndpoints;
  },
};

// ─── 自動註冊 ─────────────────────────────────────────────────────────────────

registerParser(openapiParser);

// ─── 匯出（供測試直接使用）─────────────────────────────────────────────────────

export { openapiParser };

/**
 * 供測試用：從 YAML 字串直接解析 endpoints
 */
export function _parseYamlStringForTesting(
  yamlContent: string,
  relFile: string,
): ApiEndpoint[] {
  const doc = yaml.load(yamlContent) as unknown;

  if (isSwaggerV2Doc(doc)) {
    console.warn(
      `openapi-parser: skipped ${relFile} (Swagger 2.0 not supported, use OpenAPI 3.x)`,
    );
    return [];
  }

  if (!isOpenApiV3Doc(doc)) {
    return [];
  }

  return extractEndpoints(doc, relFile);
}
