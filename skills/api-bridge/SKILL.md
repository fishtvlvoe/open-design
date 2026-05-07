---
name: api-bridge
description: |
  把 Open Design 設計好的 UI，自動跟既有專案的後端銜接起來。
  讀使用者既有 codebase（OpenAPI / Express / Next.js / WordPress）→
  互動式建立 UI ↔ API connection map →
  產出 Spectra change（proposal/design/tasks.md）→
  hand off 給 Claude Code 寫銜接代碼。
  使用時機：使用者有既有後端專案，要為它加 UI 或修銜接斷層。
triggers:
  - "銜接後端"
  - "接 API"
  - "前後端串接"
  - "中間層"
  - "connection map"
  - "wire up backend"
  - "bridge backend"
od:
  mode: prototype
  platform: any
  scenario: engineering
  preview:
    type: html
    entry: connection-map.html
  design_system:
    requires: false
  craft:
    requires: [scan-codebase, interactive-mapping, spectra-export]
---

# api-bridge Skill

把設計好的 UI 跟既有後端接起來，產出可直接餵給 Claude Code 的銜接規格。

依賴的兩個 adapter（皆位於 `adapters/` 內，由 daemon 提供）：

- **codebase-scanner** — `scanProject(rootDir: string): Promise<ScanResult>`
  回傳 `{ techStack, apis, components, scannedAt }`，apis 為 `ApiEndpoint[]`，components 由
  `scanUiComponents()` 補齊。
- **spectra-exporter** — `exportSpectraChange(input: ExportInput): Promise<ExportResult>`
  回傳 `{ changeName, files, validateResult, analyzeFindings }`，
  `analyzeFindings: AnalysisFinding[]`，每筆含 `{ severity, category, file, message }`。

## Workflow Steps

整個銜接流程拆成 6 個確定性步驟。每一步都有輸入、行動、輸出與失敗處理；
跨步驟的資料以結構化物件傳遞（避免文字解析）。

### Step 1 — 接收輸入

- **輸入**：使用者於 chat 描述需求，至少提供：
  - `targetProject`（既有專案絕對路徑）
  - `designSource`（Open Design 內目前的設計檔或元件位置）
- **行動**：以表單式追問補齊缺漏欄位（路徑、要銜接的 UI 元件、想接的 API 方向）。
- **輸出**：`{ targetProject, designSource, intent }` 結構化物件。
- **失敗處理**：使用者拒絕提供路徑 → 中止並回覆「需要目標專案路徑才能掃描」，不做任何寫入。

### Step 2 — 掃描 codebase

- **輸入**：`targetProject`。
- **行動**：呼叫 `scanProject(targetProject)`（來自 `adapters/codebase-scanner`）。
  此函式內部會：
  1. 載入 mtime cache（`<rootDir>/.open-design/scanner-cache.json`）。
  2. 讀取 `package.json` 偵測 techStack（next / express / fastify / koa / hono）。
  3. 平行跑所有已註冊 parser 的 `detect()` → `parse()`（Express / Next.js / WordPress / OpenAPI）。
  4. 合併並以 `method:path` 為唯一鍵去重。
  另外呼叫 `scanUiComponents(targetProject)` 取得 UI 元件清單。
- **輸出**：`ScanResult`（型別定義於 `adapters/codebase-scanner/types.ts`）。
- **失敗處理**：
  - `scanProject` 回 `{ techStack: [], apis: [] }` → 視為 Pre-flight 失敗（見下節），中止並提示框架未偵測到。
  - cache 讀寫失敗 → 不阻斷掃描流程（adapter 內已忽略），照常繼續。

### Step 3 — 顯示掃描報告

- **輸入**：`ScanResult`。
- **行動**：在 chat 內以表格輸出，欄位固定為 **Severity / Category / File / Message**：
  - Severity：`info`（已存在 endpoint）/ `warning`（UI 元件無對應 API）/ `error`（路徑解析失敗）。
  - Category：`api` / `ui-component` / `tech-stack`。
  - File：相對於 `targetProject` 的路徑（必要時附行號）。
  - Message：一行人類可讀描述。
  - 報告底部摘要：「找到 N 個 API、M 個 UI 元件、K 個待銜接缺口」。
- **輸出**：人類可讀報告 + 內部保留的 `ScanResult`，繼續傳給 Step 4。
- **失敗處理**：報告為空 → 提示「未偵測到任何 API 或 UI 元件，請確認專案結構」並中止。

### Step 4 — 互動式 Mapping

- **輸入**：`ScanResult` + 使用者意圖。
- **行動**：在 Open Design chat panel 內逐一詢問每個缺口的銜接決策：
  - 對應到既有 API（reuse）／新增 API（create）／延後處理（skip）。
  - 若選 create：追問 method / path / parameters。
  - 同步在 preview panel（`connection-map.html`）即時繪出左欄 UI、右欄 API、中間連線。
- **輸出**：`ConnectionMap`（型別定義於 `adapters/codebase-scanner/types.ts`，
  其中 `connections[].status` 為 `'connected' | 'missing'`，由 spectra-exporter 用來區分要產生的 task）。
- **失敗處理**：
  - 使用者中途取消 → 不寫檔，保留目前 map 為 draft，下次可從 cache 續做。
  - mapping 結果無任何 `missing` 連線 → 仍可匯出，但提示「沒有需新增的 endpoint，僅產生 wire-up tasks」。

### Step 5 — 匯出 Spectra change

- **輸入**：`ExportInput = { targetProject, changeName, connectionMap }`。
- **行動**：呼叫 `exportSpectraChange(input)`（來自 `adapters/spectra-exporter`）。
  此函式內部會：
  1. 確認 `targetProject/openspec/` 存在（不存在直接拋錯）。
  2. `spectra new change <name>`（已存在則靜默略過）。
  3. 依 `proposal / design / tasks` 三件套分別走 `spectra new artifact <type> --stdin --force`，
     失敗時依 stderr 啟動 `autoFix()`（修 Scenario header / Given-When-Then 粗體）並 retry 一次。
  4. `spectra validate <name>` → 取得 `'pass' | 'fail'`。
  5. `spectra analyze <name> --json` → 解析為 `AnalysisFinding[]`。
- **輸出**：`ExportResult`，包含產出檔案路徑陣列、validate 結果、analyze findings。
- **失敗處理**：
  - `openspec/` 不存在 → adapter 直接拋錯，skill 把錯誤訊息原文回覆使用者並中止。
  - `spectra new artifact` 失敗且 autoFix 也救不回 → 拋錯，提示使用者檢查模板填值與
    spectra CLI 版本，並列出 stderr 全文。
  - `validateResult === 'fail'` 或 findings 含 `severity === 'Critical'`：不丟錯，但在 Step 6 顯眼標示。

### Step 6 — Handoff 給 Claude Code

- **輸入**：`ExportResult`。
- **行動**：在 chat 顯示：
  ```
  connection map 已產出：
    openspec/changes/<changeName>/
      - proposal.md
      - design.md
      - tasks.md

  validate: pass | fail
  analyze findings：N 筆（Critical X / Warning Y / Suggestion Z）

  下一步：在你的專案終端跑
    /spectra-apply <changeName>
  ```
  validate 失敗或有 Critical findings 時，先列出問題清單，再給上述指令並加註「建議先處理 Critical 後再 apply」。
- **輸出**：使用者可直接複製的下一步指令。
- **失敗處理**：若 ExportResult 有 fail / Critical → 不刪除已產出檔案，僅標示需手動修；
  使用者可選擇「先 apply」或「叫 skill 重跑 Step 4 重新 mapping」。

## Pre-flight Checks

匯出前依序檢查；任一條失敗就中止，並回覆所列訊息（不自動補救、不寫檔）。

1. **target path 存在且為 directory**
   - 行動：`fs.stat(targetProject)` 確認是 directory。
   - 失敗訊息：`Target project path does not exist or is not a directory: <path>`。
2. **target 是 git repo**
   - 行動：在 targetProject 跑 `git rev-parse --git-dir`。
   - 失敗訊息：`Target project is not a git repository — refusing to write Spectra artifacts to an unversioned directory.`
3. **target 有 openspec/ 目錄**
   - 行動：`fs.existsSync(join(targetProject, 'openspec'))`。
   - 失敗訊息：`Target project has no openspec/ directory. Run 'spectra init' in <path> first; api-bridge does not auto-init.`
   - 注意：spectra-exporter 內部也會檢查並拋錯（見 `exportSpectraChange` 第一步），這裡先行檢查是為了給更清楚的訊息且避免之後動到 spectra CLI。
4. **至少一個框架 parser detect 到**
   - 行動：在 `scanProject()` 回傳後檢查 `result.techStack.length > 0 || result.apis.length > 0`。
   - 失敗訊息：`No supported framework detected in <path> (looked for: nextjs / express / fastify / koa / hono / wordpress / openapi). api-bridge requires at least one parser match.`

四項皆通過才進入 Step 4 mapping。

## Self-Critique After Export

匯出完成後（Step 5 收到 `ExportResult`），自動跑下列 4 維度 checklist。
任一維度未過 → 在 Step 6 報告中標示，並提示修正流程。

### 1. Coverage — 設計決策都被引用？

- 檢查：`design.md` 內每一個被列為「決策」的條目（API contract、UI binding），
  是否在 `tasks.md` 至少出現一次（以檔案路徑或 endpoint 字串比對）。
- 不過時的修正流程：找出缺漏的 design 決策 → 在 chat 提示「以下決策未被任何 task 引用：…」→
  使用者選擇 (a) 退回 Step 4 補 mapping 重新匯出，或 (b) 標記為 pending 留待 apply 階段補。

### 2. Specificity — 每個 task 都夠具體？

- 檢查：`tasks.md` 內每一個 task 都同時具備：
  - 具體檔案路徑（`<file>:<line>` 或 `<file>`）。
  - 工具標記（`[Tool: Sonnet]` 或 `[Tool: Copilot]`）。
  - 驗收條件（task 描述含 endpoint method+path 或 UI 元件名稱）。
- 不過時的修正流程：列出有缺項的 task → 自動改寫補上（spectra-exporter 模板已強制這三項，
  若仍有缺漏多半是 ConnectionMap 資料不全），再次呼叫 `exportSpectraChange()`。

### 3. Consistency — spec scenarios 都被覆蓋？

- 檢查：`exportResult.analyzeFindings` 中 `category === 'Consistency'` 的筆數應為 0。
- 不過時的修正流程：把每筆 Consistency finding 的 message + file 列給使用者，
  並建議「在 spec 加 scenario」或「在 tasks.md 加對應 task」二擇一；修正後重跑 Step 5。

### 4. Implementability — 任務粒度合理？

- 檢查：`tasks.md` 的 task 數量 / 每個 task 描述長度，避免出現「實作整套後端」這種過大粒度。
  經驗法則：單一 task 應落在 30 分鐘可完成的範圍（單一 endpoint、單一元件、單一驗收條件）。
- 不過時的修正流程：偵測到 task 描述含多個 endpoint 或多個元件 → 自動拆分為更細任務 →
  重跑 Step 5。若 spectra-exporter 模板已是 1-endpoint-per-task 仍超標，標記為 pending
  並把超大 task 列在 Step 6 報告中由使用者裁決。

四個維度都通過才在 Step 6 顯示「ready to apply」綠燈；否則改顯示「ready with caveats」並列出未過項目。

## Limitations（v0.1）

- 只支援單一專案（不跨 monorepo workspace）。
- API 提取準確度視技術棧而定（OpenAPI > Next.js > Express > WordPress）。
- 不做即時 API 戳測（只靜態解析）。
- 不處理 auth / OAuth / API key（純文件層銜接）。
- 同一進程不支援並行掃描多個 rootDir（codebase-scanner cache 為全域 active 模式）。
