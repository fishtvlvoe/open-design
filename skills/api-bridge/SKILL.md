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

## Workflow

1. **接收 user input**：使用者在 chat 描述「為哪個專案做什麼 UI 銜接」
   範例：「為 FlowGo 的排程發布按鈕，銜接後端排程 API」

2. **掃描既有專案 codebase**（透過 daemon 提供的 codebase-scanner adapter）：
   - 偵測技術棧（package.json / composer.json / requirements.txt）
   - 提取 API 清單：
     - WordPress：grep `register_rest_route` + `add_action`
     - Next.js：掃 `app/api/**/route.ts` 路由檔
     - Express：找 `app.get/post` + `router.METHOD`
     - OpenAPI：讀 `*.yaml` / `*.json` swagger 檔
   - 提取既有 UI 元件清單（grep `onClick` + `data-testid`）
   - 回傳結構化清單給 chat

3. **互動式 mapping**（在 Open Design chat panel 裡）：
   ```
   AI: 我在 FlowGo 找到 12 個 API 跟 47 個 UI 元件。
       你說的「排程發布按鈕」對應到 PublishNodeCard.tsx 第 123 行。
       它目前是 console.log placeholder，沒有後端對應。
       
       後端我找到相關 API：
       1. POST /api/publish（立即發布，已存在）
       2. POST /api/publish/schedule（排程發布，不存在）
       
       要我幫你：
       A. 銜接到既有 /api/publish，加 scheduleAt 參數
       B. 新增 /api/publish/schedule endpoint
       C. 你有別的想法？
   
   User: B
   
   AI: 好。新 endpoint 需要哪些參數？
       建議：content, nodeId, scheduleAt
   
   User: 對
   
   AI: 排程資料要怎麼存？
       建議：先寫進 DB（scheduled_publishes table），由 cron worker 到期觸發
   
   User: 第一版用 stub 就好，不真的入 DB
   
   AI: 收到，產出 connection map...
   ```

4. **產出 connection map**：在 Open Design preview panel 即時顯示
   - 視覺化：左欄 UI 元件 / 右欄 API endpoint / 中間連線
   - 結構化資料：JSON + Markdown 並陳

5. **匯出 Spectra change**：
   - 寫到 user 專案的 `openspec/changes/<change-name>/`
   - 三件套：proposal.md / design.md / tasks.md
   - tasks.md 每個 task 標 `[Tool: Copilot/Sonnet]`
   - 自動跑 `spectra validate` + `spectra analyze`

6. **handoff 提示**：
   ```
   AI: connection map 已產出到：
       openspec/changes/wire-schedule-publish/
       
       下一步：
       在你的 FlowGo 終端跑：
       /spectra-apply wire-schedule-publish
       
       Claude Code 會根據這份 map 寫銜接代碼。
   ```

## Pre-flight Checks

- [ ] 使用者有指定目標專案路徑
- [ ] 目標專案有 git（避免無控版號污染）
- [ ] 目標專案有 openspec/ 目錄（或允許新建）
- [ ] 至少偵測到一種後端技術棧

## Self-Critique（產出後）

1. **Coverage**：connection map 是否涵蓋所有需要銜接的元件？
2. **Specificity**：每條線都有具體 API 路徑 + 參數，沒有 TBD / TODO？
3. **Consistency**：tasks.md 的 task 跟 design.md 的決策一致？
4. **Implementability**：Claude Code 能不能不問人就把這份 map 寫出來？

## Limitations（v0.1）

- 只支援單一專案（不跨 monorepo workspace）
- API 提取準確度視技術棧而定（OpenAPI > Next.js > Express > WordPress）
- 不做即時 API 戳測（只靜態解析）
- 不處理 auth / OAuth / API key（純文件層銜接）
