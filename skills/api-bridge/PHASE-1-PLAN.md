# api-bridge Skill — Phase 1 開發計畫

**狀態**：規劃中
**分支**：`feat/api-bridge-skill`
**目標**：在 Open Design 加 api-bridge skill，讓使用者在 Open Design chat 裡描述需求，自動產出 Spectra change 給 Claude Code 寫銜接代碼。

---

## 為什麼做這件事

從 2026-05-07 五輪討論 + PoC 驗證得出（紀錄在 `/Users/fishtv/Development/0-OpenWeb/openspec/discussions/`）：

- 痛點：Fish 的所有專案（FlowGo / MOLTOS / three-ai / BuyGo+1 / Gmail 同步）都遇到「UI ↔ 後端銜接斷層」
- 原方案：做獨立 8 個月的 OpenWeb Tauri app
- 真實情況：Open Design 已涵蓋 80%，缺的只是「銜接層 skill」
- 方向修正：把 OpenWeb 變成 Open Design 的一個 skill，工程量從 8 個月縮為 5~6 週

---

## Phase 1 範圍（2~3 週）：Codebase Scanner

api-bridge 的核心依賴是「能讀懂使用者既有專案的 API 清單」。Phase 1 做這個。

### 子任務

#### Task 1.1：適配器架構（3 天）

**目標**：在 `adapters/codebase-scanner/` 建立可擴充的解析器框架

**檔案**：
- `adapters/codebase-scanner/index.ts` — 主入口
- `adapters/codebase-scanner/types.ts` — 共用型別定義
- `adapters/codebase-scanner/registry.ts` — 解析器註冊機制

**型別定義範例**：
```typescript
type ApiEndpoint = {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  path: string;
  source: { file: string; line: number };
  framework: 'express' | 'nextjs' | 'wordpress' | 'openapi';
  parameters?: Array<{ name: string; type: string; required: boolean }>;
};

type UiComponent = {
  name: string;          // 例如 "排程發布按鈕"
  source: { file: string; line: number };
  type: 'button' | 'form' | 'input' | 'link';
  hasHandler: boolean;
  isPlaceholder: boolean; // onClick 是 console.log 之類
};

type ScanResult = {
  techStack: string[];
  apis: ApiEndpoint[];
  components: UiComponent[];
  scannedAt: string;
};
```

**派工**：Copilot CLI（型別 + scaffold）

#### Task 1.2：Express 解析器（3 天）

**目標**：解析 Express 風格的 routes（FlowGo / 不動產用的）

**做的事**：
- 找 `app.get()`, `app.post()`, `router.get()`, `router.post()` 等
- 解析路徑 + HTTP 方法
- 嘗試提取 req.body / req.params / req.query 用法（推測參數）
- 回傳 `ApiEndpoint[]`

**測試對象**：FlowGo `apps/api/src/`

**派工**：Sonnet 子代理（需要 AST parsing 推理）

#### Task 1.3：Next.js 解析器（3 天）

**目標**：解析 Next.js App Router 路由

**做的事**：
- 掃 `app/api/**/route.ts`
- 偵測 export 的 `GET / POST / PUT / DELETE` 函式
- 推測 body shape（從 zod schema 或 type）
- 回傳 `ApiEndpoint[]`

**測試對象**：MOLTOS `app/api/`

**派工**：Sonnet 子代理

#### Task 1.4：WordPress 解析器（3 天）

**目標**：解析 WP REST API 註冊

**做的事**：
- 找 `register_rest_route()` 呼叫
- 解析 namespace / route / methods / callback
- 回傳 `ApiEndpoint[]`

**測試對象**：BuyGo+1 / LineHub

**派工**：Sonnet 子代理（PHP grep + AST 較少成熟工具）

#### Task 1.5：OpenAPI 解析器（2 天）

**目標**：讀標準 OpenAPI 3.0 yaml/json

**做的事**：
- 找 `*.openapi.yaml` / `swagger.json` 等
- 標準化讀 paths / methods / parameters
- 回傳 `ApiEndpoint[]`

**測試對象**：inkgo `zernio-api-openapi.yaml`

**派工**：Copilot CLI（用 `openapi-typescript` 之類成熟套件）

#### Task 1.6：UI Component 掃描器（3 天）

**目標**：找 React 元件裡的 onClick handlers 跟 placeholder

**做的事**：
- 遞迴掃 `*.tsx`
- 找 `onClick={...}` / `<button>` / `<form onSubmit>`
- 判斷是否 placeholder（`console.log` / 空 handler / TODO 註解）
- 回傳 `UiComponent[]`

**派工**：Sonnet 子代理

#### Task 1.7：整合測試（2 天）

**目標**：用 Fish 的 5 個真實專案測 scanner

**驗收條件**：
- FlowGo：12+ APIs，47+ UI 元件
- MOLTOS：API 數量合理
- BuyGo+1：WP REST routes 正確抓到
- 至少 90% 已知 API 不漏抓

**派工**：主對話 + 主作戰

### Phase 1 工程量

| Task | 預估 | 派工 |
|------|------|------|
| 1.1 架構 | 3 天 | Copilot |
| 1.2 Express | 3 天 | Sonnet |
| 1.3 Next.js | 3 天 | Sonnet |
| 1.4 WordPress | 3 天 | Sonnet |
| 1.5 OpenAPI | 2 天 | Copilot |
| 1.6 UI 掃描 | 3 天 | Sonnet |
| 1.7 整合測試 | 2 天 | 主對話 |
| **總計** | **約 19 工作天 ≈ 4 週** | |

---

## Phase 1 驗收

- [ ] 跑 `od scan /path/to/flowgo` 在 5 秒內回傳 ScanResult
- [ ] 5 個真實專案都能掃，準確度 > 90%
- [ ] CLI 介面 + JSON 輸出
- [ ] 可被 Open Design daemon 透過 IPC 呼叫
- [ ] 至少 70% 程式碼覆蓋率

---

## Phase 2~4 預告（不在這次計畫範圍）

- **Phase 2（1~2 週）**：互動式 mapping chat 流程 + connection-map 視覺化
- **Phase 3（1 週）**：Spectra change exporter
- **Phase 4（1 週）**：dogfood + 真實專案測試 + 修 bug

**全部完成總時程**：5~7 週

---

## 風險與緩解

| 風險 | 嚴重度 | 緩解 |
|------|--------|------|
| Express 解析器涵蓋不全（router 巢狀、middleware） | 高 | 第一版只支援頂層 + 一層 router |
| WordPress hook 動態註冊難解析 | 中 | 第一版只做 `register_rest_route`，hook 列入 v2 |
| TypeScript AST 解析成本高 | 中 | 用 `@babel/parser` + `@babel/traverse` 既有方案 |
| 5 個真實專案技術棧差異大 | 中 | 先做最常用的（Express + Next.js + WP），其他 fallback |

---

## 下一步決策點

1. 接受 Phase 1 計畫 → 派工 Task 1.1（架構）
2. 計畫要修改 → Fish 指出哪裡要改

## Phase 1 實際結果（2026-05-07）

### 完成狀態

- Wave 1-7 + 9 + 10 + 11.1 + 11.2 已完成（11.3 因 FlowGo 工作樹有 WIP 暫停）
- Phase 1 完成度：21/24 tasks（87.5%），剩 11.3（FlowGo apply）+ 12.4（archive）

### Scanner 在 5 個真實專案的結果

- FlowGo（Express + React）：29 APIs / 164 components，首掃 45s / 增量 0.65s
- MOLTOS（Next.js）：25 APIs
- BuyGo+1（WordPress）：99 endpoints
- inkgo（OpenAPI）：183 endpoints
- three-ai（Next.js Electron）：0 APIs（正確 — 無 HTTP API surface）

### 效能與驗證

- Wave 7 mtime 快取驗證：FlowGo 增量掃描 70x 加速
- Wave 11 E2E：產出 wire-schedule-publish change，在 FlowGo 通過 `spectra validate` + `spectra analyze` 0 findings
- Wave 11 修復了一個 spectra-exporter bug：`tasks.md.tpl` 缺 design 主題引用，導致 Consistency findings
- 92 unit tests 全綠；typecheck 0 錯
