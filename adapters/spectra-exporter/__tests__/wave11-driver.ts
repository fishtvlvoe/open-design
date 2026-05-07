/**
 * Wave 11 E2E driver — 整合測試
 *
 * 用 codebase-scanner + spectra-exporter 兩個 adapter 模擬 api-bridge skill
 * 對 FlowGo 排程發布案例的完整流程，產出 Spectra change 並驗證它通過
 * `spectra validate` + `spectra analyze` 0 findings。
 *
 * 執行：
 *   ./node_modules/.bin/tsx adapters/spectra-exporter/__tests__/wave11-driver.ts
 */

import { scanProject, scanUiComponents } from '../../codebase-scanner/index.ts';
import type {
  ConnectionMap,
  ApiEndpoint,
  UiComponent,
} from '../../codebase-scanner/types.ts';
import { exportSpectraChange } from '../index.ts';

const FLOWGO = '/Users/fishtv/Development/products/flowgo';

function findApi(
  apis: ApiEndpoint[],
  method: string,
  pathSubstr: string,
): ApiEndpoint | undefined {
  return apis.find(
    (a) => a.method === method && a.path.includes(pathSubstr),
  );
}

function pickComponent(
  components: UiComponent[],
  predicate: (c: UiComponent) => boolean,
): UiComponent | undefined {
  return components.find(predicate);
}

async function main() {
  console.log('━━━ Wave 11 driver — FlowGo 排程發布串接 ━━━');
  console.log(`目標：${FLOWGO}`);

  // ─── 1. 掃 API ───────────────────────────────────────────────────────────
  const scan = await scanProject(FLOWGO);
  console.log(`\n[scan] techStack: ${scan.techStack.join(', ')}`);
  console.log(`[scan] apis: ${scan.apis.length}`);

  // ─── 2. 掃 UI 元件（scanProject 回傳的 components 為空，需另呼叫） ───────
  const components = await scanUiComponents(FLOWGO);
  console.log(`[scan] components: ${components.length}`);

  // 印部分 components 名稱方便挑選
  console.log('\n[components 樣本]');
  components.slice(0, 20).forEach((c) => {
    console.log(`  - ${c.type} "${c.name}" @ ${c.source.file}:${c.source.line}`);
  });

  // ─── 3. 建 ConnectionMap ─────────────────────────────────────────────────
  // existing connection：用真實已存在的 GET /api/credits（apps/api/src/routes/credits.ts）
  // missing connection：「排程發布」按鈕 → POST /api/schedule/publish（尚未實作的目標端點）

  const existingApi = findApi(scan.apis, 'GET', '/credits');
  if (!existingApi) {
    throw new Error('scan 沒找到 GET /credits，請確認 apps/api 已掃到');
  }

  // 挑一個跟 credits 概念貼近的 UI（任何 button/link 都行；用 fallback 確保有值）
  const existingComponent =
    pickComponent(components, (c) =>
      /credit|餘額|點數|cost/i.test(c.name),
    ) ??
    pickComponent(components, (c) => c.type === 'button') ??
    components[0];

  if (!existingComponent) {
    throw new Error('scan 沒找到任何 UI component');
  }

  // 挑一個排程發布相關 UI（PublishNodeCard 修改中，可能在 dirty tree 中已有）
  const scheduleComponent =
    pickComponent(components, (c) =>
      /publish|schedule|排程|發布/i.test(c.name),
    ) ??
    pickComponent(
      components,
      (c) => c.type === 'button' && c !== existingComponent,
    ) ??
    components[1] ??
    existingComponent;

  // missing API：POST /api/schedule/publish（尚未實作）
  const missingApi: ApiEndpoint = {
    method: 'POST',
    path: '/api/schedule/publish',
    source: {
      file: 'apps/api/src/routes/schedule-publish.ts',
      line: 1,
    },
    framework: 'express',
    parameters: [
      { name: 'flowId', type: 'string', required: true },
      { name: 'scheduledAt', type: 'string', required: true },
      { name: 'channelIds', type: 'string[]', required: true },
    ],
  };

  const connectionMap: ConnectionMap = {
    connections: [
      {
        from: existingComponent,
        to: existingApi,
        status: 'existing',
      },
      {
        from: scheduleComponent,
        to: missingApi,
        status: 'missing',
      },
    ],
  };

  console.log('\n[ConnectionMap 摘要]');
  for (const c of connectionMap.connections) {
    console.log(
      `  [${c.status}] ${c.from.type} "${c.from.name}" → ${c.to.method} ${c.to.path}`,
    );
  }

  // ─── 4. 執行 export ──────────────────────────────────────────────────────
  console.log('\n[export] 呼叫 exportSpectraChange ...');
  const result = await exportSpectraChange({
    connectionMap,
    targetProject: FLOWGO,
    changeName: 'wire-schedule-publish',
  });

  // ─── 5. 印結果 ───────────────────────────────────────────────────────────
  console.log('\n━━━ ExportResult ━━━');
  console.log(`changeName     : ${result.changeName}`);
  console.log(`validateResult : ${result.validateResult}`);
  console.log('files:');
  result.files.forEach((f) => console.log(`  - ${f}`));

  console.log(`\n[analyze findings: ${result.analyzeFindings.length}]`);
  if (result.analyzeFindings.length > 0) {
    const headers = ['#', 'severity', 'category', 'file', 'message'];
    console.log(headers.join(' | '));
    console.log('---|---|---|---|---');
    result.analyzeFindings.forEach((f, i) => {
      console.log(
        [
          i + 1,
          f.severity,
          f.category,
          f.file,
          f.message.slice(0, 80).replace(/\n/g, ' '),
        ].join(' | '),
      );
    });
  } else {
    console.log('(無 findings)');
  }

  // ─── 6. 退出狀態 ─────────────────────────────────────────────────────────
  if (result.validateResult !== 'pass' || result.analyzeFindings.length > 0) {
    console.error(
      '\n❌ Wave 11 未達標：validate 通過? ' +
        result.validateResult +
        '；findings ' +
        result.analyzeFindings.length,
    );
    process.exitCode = 1;
  } else {
    console.log('\n✅ Wave 11 達標：validate=pass、analyze=0 findings');
  }
}

main().catch((err) => {
  console.error('\n[driver crashed]', err);
  process.exitCode = 1;
});
