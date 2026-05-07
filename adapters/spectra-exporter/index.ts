/**
 * spectra-exporter adapter
 *
 * ExportInput（ConnectionMap + targetProject + changeName）→
 * spectra CLI 三件套（proposal / design / tasks）+
 * spectra validate + analyze 結果
 *
 * 不直接寫檔；全程透過 `spectra new artifact --stdin` 子程序。
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import type { ExportInput, ConnectionMap } from '../codebase-scanner/types.ts';

// ─── 型別 ────────────────────────────────────────────────────────────────────

export interface AnalysisFinding {
  severity: 'Critical' | 'Warning' | 'Suggestion';
  category: string;
  file: string;
  message: string;
}

export interface ExportResult {
  changeName: string;
  files: string[];
  validateResult: 'pass' | 'fail';
  analyzeFindings: AnalysisFinding[];
}

// ─── 路徑 ────────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const TPL_DIR = join(__dirname, 'templates');

// ─── 中文 → kebab-case 名稱轉換 ─────────────────────────────────────────────

/**
 * 對照表：常見中文詞組 → 英文片語
 * 規格要求：無 LLM 時用 transliteration table 或 hardcoded common phrases
 */
const PHRASE_TABLE: ReadonlyArray<[RegExp, string]> = [
  // 動詞
  [/修[復|改|正]?/, 'fix'],
  [/加[入|上]?/, 'add'],
  [/刪除|移除/, 'remove'],
  [/更新/, 'update'],
  [/建立|新增/, 'create'],
  [/串接|銜接|接上/, 'wire'],
  [/橋接/, 'bridge'],
  [/綁定/, 'bind'],
  [/驗證|核驗/, 'verify'],
  [/排程/, 'schedule'],
  [/發布|發佈/, 'publish'],
  [/登入|登錄/, 'login'],
  [/登出/, 'logout'],
  [/會員/, 'member'],
  [/訂單/, 'order'],
  [/下單/, 'checkout'],
  [/付款|支付/, 'payment'],
  [/按鈕/, 'button'],
  [/介面|UI/, 'ui'],
  [/API/, 'api'],
  [/測試/, 'test'],
  [/部署/, 'deploy'],
  [/設定|配置/, 'config'],
  [/認證|授權/, 'auth'],
];

/**
 * 將中文或混合文字轉成 kebab-case ASCII，並產出三個候選名稱。
 * 規格：至少提供一個選項；三個候選代表不同語義角度。
 */
export function generateCandidateNames(input: string): [string, string, string] {
  // 先嘗試分詞替換
  let tokens: string[] = [];

  // 逐個 phrase 替換（維持順序）
  let remaining = input.trim();
  const matched: string[] = [];

  for (const [pattern, replacement] of PHRASE_TABLE) {
    if (pattern.test(remaining)) {
      matched.push(replacement);
      remaining = remaining.replace(pattern, ' ');
    }
  }

  // 剩餘非 ASCII 字元用拼音首字母縮寫替代（確保有值）
  const asciiOnly = remaining.replace(/[\u4e00-\u9fff\u3000-\u303f]/g, '').trim();
  if (asciiOnly.length > 0) {
    tokens = [...matched, ...asciiOnly.split(/\s+/).filter(Boolean)];
  } else {
    tokens = matched;
  }

  if (tokens.length === 0) {
    tokens = ['change'];
  }

  const base = tokens.join('-').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');

  // 三個候選：直接拼、加 wire- 前綴、加 bridge- 前綴（語義角度不同）
  const c1 = base;
  const c2 = base.startsWith('wire-') ? base.replace(/^wire-/, 'add-') : `wire-${base}`;
  const c3 = base.startsWith('bridge-')
    ? base.replace(/^bridge-/, 'bind-')
    : `bridge-${base}`;

  return [c1, c2, c3];
}

// ─── 模板填充 ─────────────────────────────────────────────────────────────────

function fill(template: string, vars: Record<string, string>): string {
  return Object.entries(vars).reduce(
    (acc, [key, value]) => acc.replaceAll(`{{${key}}}`, value),
    template
  );
}

async function loadTemplate(name: string): Promise<string> {
  return readFile(join(TPL_DIR, name), 'utf-8');
}

// ─── 內容生成 ─────────────────────────────────────────────────────────────────

function buildConnectionsTable(map: ConnectionMap): string {
  const header = '| UI Component | File:Line | API Endpoint | Status |\n| ------------ | --------- | ------------ | ------ |';
  const rows = map.connections.map(c => {
    const uiRef = `${c.from.name}`;
    const uiLoc = `${c.from.source.file}:${c.from.source.line}`;
    const apiRef = `${c.to.method} ${c.to.path}`;
    return `| ${uiRef} | ${uiLoc} | ${apiRef} | ${c.status} |`;
  });
  return [header, ...rows].join('\n');
}

function buildMissingConnectionsList(map: ConnectionMap): string {
  const missing = map.connections.filter(c => c.status === 'missing');
  if (missing.length === 0) return '_(none — all connections already implemented)_';
  return missing.map(c =>
    `- **${c.from.name}** (${c.from.source.file}:${c.from.source.line}) → \`${c.to.method} ${c.to.path}\``
  ).join('\n');
}

function buildApiContracts(map: ConnectionMap): string {
  const endpoints = [...new Map(map.connections.map(c => [c.to.path + c.to.method, c.to])).values()];
  return endpoints.map(ep => {
    const params = ep.parameters && ep.parameters.length > 0
      ? ep.parameters.map(p => `  - \`${p.name}\` (${p.type}${p.required ? ', required' : ', optional'})`).join('\n')
      : '  _(none declared)_';
    return `#### \`${ep.method} ${ep.path}\`\n\n**Framework**: ${ep.framework}\n**Source**: ${ep.source.file}:${ep.source.line}\n**Parameters**:\n${params}`;
  }).join('\n\n');
}

function buildUiBindings(map: ConnectionMap): string {
  return map.connections.map(c =>
    `- **${c.from.name}** (\`${c.from.type}\`) at ${c.from.source.file}:${c.from.source.line} → \`${c.to.method} ${c.to.path}\``
  ).join('\n');
}

/**
 * tasks.md 任務分工原則：
 * - API 路由新增、複雜整合 → [Tool: Sonnet]
 * - 驗證、型別檢查、測試執行 → [Tool: Copilot]
 */
function buildApiTasks(map: ConnectionMap): string {
  const endpoints = [...new Map(map.connections.map(c => [c.to.path + c.to.method, c.to])).values()];
  return endpoints.map((ep, i) => {
    const taskNum = `1.${i + 1}`;
    const title = `Implement \`${ep.method} ${ep.path}\` route handler (${ep.source.file})`;
    return `- [ ] ${taskNum} ${title} \`[Tool: Sonnet]\``;
  }).join('\n');
}

function buildUiTasks(map: ConnectionMap): string {
  return map.connections.map((c, i) => {
    const taskNum = `2.${i + 1}`;
    const title = `Wire ${c.from.name} (${c.from.source.file}:${c.from.source.line}) to call \`${c.to.method} ${c.to.path}\``;
    return `- [ ] ${taskNum} ${title} \`[Tool: Sonnet]\``;
  }).join('\n');
}

function detectFramework(map: ConnectionMap): string {
  const frameworks = [...new Set(map.connections.map(c => c.to.framework))];
  return frameworks.join(', ') || 'unknown';
}

async function buildProposalContent(input: ExportInput): Promise<string> {
  const tpl = await loadTemplate('proposal.md.tpl');
  return fill(tpl, {
    summary: `Wire ${input.connectionMap.connections.length} UI–API connection(s) detected in the codebase scan for change \`${input.changeName}\`.`,
    missing_connections_list: buildMissingConnectionsList(input.connectionMap),
    connections_table: buildConnectionsTable(input.connectionMap),
  });
}

async function buildDesignContent(input: ExportInput): Promise<string> {
  const tpl = await loadTemplate('design.md.tpl');
  return fill(tpl, {
    connections_table: buildConnectionsTable(input.connectionMap),
    api_contracts: buildApiContracts(input.connectionMap),
    ui_bindings: buildUiBindings(input.connectionMap),
    framework: detectFramework(input.connectionMap),
  });
}

async function buildTasksContent(input: ExportInput): Promise<string> {
  const tpl = await loadTemplate('tasks.md.tpl');
  return fill(tpl, {
    api_tasks: buildApiTasks(input.connectionMap),
    ui_tasks: buildUiTasks(input.connectionMap),
  });
}

// ─── 子程序執行 ───────────────────────────────────────────────────────────────

interface SubprocessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runSpectra(args: string[], stdin: string, cwd: string): Promise<SubprocessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('spectra', args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    child.on('error', reject);

    child.on('close', (code) => {
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });

    child.stdin.write(stdin, 'utf-8');
    child.stdin.end();
  });
}

/**
 * Auto-recovery：依據 stderr 自動修正常見問題（一次）
 * 規格範例：`### Scenario:` → `#### Scenario:`
 */
function autoFix(content: string, stderr: string): string | null {
  // 修正 1：Scenario header 層級
  if (/scenario uses 3 hashtags/i.test(stderr) || /expected 4/i.test(stderr)) {
    return content.replace(/^### Scenario:/gm, '#### Scenario:');
  }
  // 修正 2：Given/When/Then 改為粗體清單
  if (/given.when.then/i.test(stderr) && /bullet/i.test(stderr)) {
    return content
      .replace(/^- GIVEN /gm, '- **GIVEN** ')
      .replace(/^- WHEN /gm, '- **WHEN** ')
      .replace(/^- THEN /gm, '- **THEN** ');
  }
  // 無法自動修正
  return null;
}

async function writeArtifact(
  type: 'proposal' | 'design' | 'tasks',
  changeName: string,
  content: string,
  cwd: string
): Promise<void> {
  const args = ['new', 'artifact', type, '--change', changeName, '--stdin', '--force'];

  // 第一次嘗試
  const result = await runSpectra(args, content, cwd);

  if (result.exitCode === 0) return;

  // 嘗試 auto-fix
  const fixed = autoFix(content, result.stderr);
  if (fixed === null) {
    throw new Error(
      `spectra new artifact ${type} failed (exit ${result.exitCode}):\n${result.stderr}`
    );
  }

  // 第二次嘗試（retry once）
  console.warn(`[spectra-exporter] auto-fix applied for ${type}; retrying...`);
  console.warn(`[spectra-exporter] stderr was: ${result.stderr}`);

  const retry = await runSpectra(args, fixed, cwd);
  if (retry.exitCode !== 0) {
    throw new Error(
      `spectra new artifact ${type} failed after auto-fix (exit ${retry.exitCode}):\n${retry.stderr}`
    );
  }
}

// ─── spectra validate + analyze ──────────────────────────────────────────────

async function runValidate(changeName: string, cwd: string): Promise<'pass' | 'fail'> {
  const result = await runSpectra(['validate', changeName, '--no-color'], '', cwd);
  return result.exitCode === 0 ? 'pass' : 'fail';
}

async function runAnalyze(changeName: string, cwd: string): Promise<AnalysisFinding[]> {
  const result = await runSpectra(['analyze', changeName, '--json', '--no-color'], '', cwd);

  if (result.exitCode !== 0 && result.stdout.trim() === '') {
    return [];
  }

  try {
    // spectra analyze --json 輸出格式推測：陣列或 { findings: [...] }
    const raw = JSON.parse(result.stdout) as unknown;

    // normalize
    const items: unknown[] = Array.isArray(raw)
      ? raw
      : (typeof raw === 'object' && raw !== null && 'findings' in raw
          ? (raw as { findings: unknown[] }).findings
          : []);

    return items
      .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
      .map(item => ({
        severity: (item['severity'] ?? item['level'] ?? 'Suggestion') as AnalysisFinding['severity'],
        // spectra analyze --json: { dimension: "Consistency", ... }
        category: String(item['dimension'] ?? item['category'] ?? item['type'] ?? 'Unknown'),
        // spectra analyze --json: { location: "design.md", ... }
        file: String(item['location'] ?? item['file'] ?? item['artifact'] ?? ''),
        // spectra analyze --json: { summary: "...", ... }
        message: String(item['summary'] ?? item['message'] ?? item['msg'] ?? ''),
      }));
  } catch {
    // JSON parse 失敗：回傳空（不阻斷流程）
    return [];
  }
}

// ─── change 初始化 ────────────────────────────────────────────────────────────

/**
 * 確保 spectra change 存在。
 * 若 change 尚不存在，先執行 `spectra new change <name>` 建立；
 * 若已存在（exit 1 with "already exists"），靜默忽略。
 */
async function ensureChangeExists(
  changeName: string,
  input: ExportInput,
  cwd: string
): Promise<void> {
  const missingCount = input.connectionMap.connections.filter(c => c.status === 'missing').length;
  const description = `Wire ${missingCount} missing UI–API connection(s) (generated by spectra-exporter)`;

  const result = await runSpectra(
    ['new', 'change', changeName, '--description', description, '--no-color'],
    '',
    cwd
  );

  if (result.exitCode === 0) return;

  // 若已存在則忽略，其他錯誤才拋
  const alreadyExists =
    /already exists/i.test(result.stderr) || /already exists/i.test(result.stdout);
  if (!alreadyExists) {
    throw new Error(
      `spectra new change ${changeName} failed (exit ${result.exitCode}):\n${result.stderr}`
    );
  }
}

// ─── 主函式 ───────────────────────────────────────────────────────────────────

export async function exportSpectraChange(input: ExportInput): Promise<ExportResult> {
  const { targetProject, changeName, connectionMap } = input;

  // 1. 確認 openspec/ 存在
  const openspecDir = join(targetProject, 'openspec');
  if (!existsSync(openspecDir)) {
    throw new Error(
      `目標專案 ${targetProject} 沒有 openspec/ 目錄，請先在該專案跑 spectra init`
    );
  }

  // 2. 確保 spectra change 存在（先建 change，再加 artifact）
  await ensureChangeExists(changeName, input, targetProject);

  // 3. 建立 artifact 內容
  const proposalContent = await buildProposalContent(input);
  const designContent = await buildDesignContent(input);
  const tasksContent = await buildTasksContent(input);

  // 4. 依序呼叫 spectra CLI（三件套）
  await writeArtifact('proposal', changeName, proposalContent, targetProject);
  await writeArtifact('design', changeName, designContent, targetProject);
  await writeArtifact('tasks', changeName, tasksContent, targetProject);

  // 5. 推算產出的檔案路徑
  const changesDir = join(openspecDir, 'changes', changeName);
  const files = [
    join(changesDir, 'proposal.md'),
    join(changesDir, 'design.md'),
    join(changesDir, 'tasks.md'),
  ];

  // 6. spectra validate
  const validateResult = await runValidate(changeName, targetProject);

  // 7. spectra analyze
  const analyzeFindings = await runAnalyze(changeName, targetProject);

  return {
    changeName,
    files,
    validateResult,
    analyzeFindings,
  };
}
