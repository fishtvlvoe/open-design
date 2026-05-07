/**
 * codebase-scanner adapter — 核心型別定義
 *
 * JSON Schema 說明：
 * 每個型別附帶對應的 JSON Schema 字面量物件，供外部 parser / exporter
 * 社群模組在執行時做契約驗證用。刻意不引入 ajv / zod，保持零額外依賴。
 */

// ─── 基本型別 ───────────────────────────────────────────────────────────────

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

export type Framework = 'express' | 'nextjs' | 'wordpress' | 'openapi';

export type UiComponentType = 'button' | 'form' | 'input' | 'link';

export type ConnectionStatus = 'existing' | 'missing';

// ─── 主要型別 ───────────────────────────────────────────────────────────────

export interface ApiEndpoint {
  /** HTTP 方法 */
  method: HttpMethod;
  /** 路由路徑，例如 /api/orders/:id */
  path: string;
  /** 來源位置 */
  source: {
    file: string;
    line: number;
  };
  /** 解析此 endpoint 的 parser */
  framework: Framework;
  /** Query / body / path 參數列表（選填） */
  parameters?: Array<{
    name: string;
    type: string;
    required: boolean;
  }>;
}

export interface UiComponent {
  /** 元件名稱或辨識標籤 */
  name: string;
  /** 來源位置 */
  source: {
    file: string;
    line: number;
  };
  /** 元件種類 */
  type: UiComponentType;
  /** 是否已綁定 handler（非 placeholder） */
  hasHandler: boolean;
  /** 啟發式判斷是否為 placeholder（console.log / 空函式 / TODO 註解） */
  isPlaceholder: boolean;
}

export interface ScanResult {
  /** 偵測到的技術棧，例如 ['nextjs', 'wordpress'] */
  techStack: string[];
  /** 掃描到的 API endpoints */
  apis: ApiEndpoint[];
  /** 掃描到的 UI 元件 */
  components: UiComponent[];
  /** ISO 8601 掃描時間戳 */
  scannedAt: string;
}

export interface ConnectionMap {
  /** UI 元件與 API endpoint 的對應關係 */
  connections: Array<{
    from: UiComponent;
    to: ApiEndpoint;
    /** existing = 已有實作；missing = 尚待串接 */
    status: ConnectionStatus;
  }>;
}

export interface ExportInput {
  /** 已建立的 connection map */
  connectionMap: ConnectionMap;
  /** 目標專案根目錄絕對路徑 */
  targetProject: string;
  /** Spectra change 名稱（英文 kebab-case） */
  changeName: string;
}

// ─── JSON Schema（字面量物件，零依賴） ──────────────────────────────────────

/** ApiEndpoint 對應的 JSON Schema */
export const ApiEndpointSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  required: ['method', 'path', 'source', 'framework'],
  additionalProperties: false,
  properties: {
    method: {
      type: 'string',
      enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    },
    path: { type: 'string' },
    source: {
      type: 'object',
      required: ['file', 'line'],
      additionalProperties: false,
      properties: {
        file: { type: 'string' },
        line: { type: 'integer', minimum: 1 },
      },
    },
    framework: {
      type: 'string',
      enum: ['express', 'nextjs', 'wordpress', 'openapi'],
    },
    parameters: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'type', 'required'],
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          type: { type: 'string' },
          required: { type: 'boolean' },
        },
      },
    },
  },
} as const;

/** UiComponent 對應的 JSON Schema */
export const UiComponentSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  required: ['name', 'source', 'type', 'hasHandler', 'isPlaceholder'],
  additionalProperties: false,
  properties: {
    name: { type: 'string' },
    source: {
      type: 'object',
      required: ['file', 'line'],
      additionalProperties: false,
      properties: {
        file: { type: 'string' },
        line: { type: 'integer', minimum: 1 },
      },
    },
    type: {
      type: 'string',
      enum: ['button', 'form', 'input', 'link'],
    },
    hasHandler: { type: 'boolean' },
    isPlaceholder: { type: 'boolean' },
  },
} as const;

/** ScanResult 對應的 JSON Schema */
export const ScanResultSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  required: ['techStack', 'apis', 'components', 'scannedAt'],
  additionalProperties: false,
  properties: {
    techStack: { type: 'array', items: { type: 'string' } },
    apis: { type: 'array', items: ApiEndpointSchema },
    components: { type: 'array', items: UiComponentSchema },
    scannedAt: { type: 'string', format: 'date-time' },
  },
} as const;

/** ConnectionMap 對應的 JSON Schema */
export const ConnectionMapSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  required: ['connections'],
  additionalProperties: false,
  properties: {
    connections: {
      type: 'array',
      items: {
        type: 'object',
        required: ['from', 'to', 'status'],
        additionalProperties: false,
        properties: {
          from: UiComponentSchema,
          to: ApiEndpointSchema,
          status: { type: 'string', enum: ['existing', 'missing'] },
        },
      },
    },
  },
} as const;

/** ExportInput 對應的 JSON Schema */
export const ExportInputSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  required: ['connectionMap', 'targetProject', 'changeName'],
  additionalProperties: false,
  properties: {
    connectionMap: ConnectionMapSchema,
    targetProject: { type: 'string' },
    changeName: {
      type: 'string',
      pattern: '^[a-z0-9]+(-[a-z0-9]+)*$',
      description: '英文 kebab-case，例如 add-payment-api',
    },
  },
} as const;
