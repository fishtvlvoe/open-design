/**
 * UI Component Scanner 單元測試
 *
 * 覆蓋範圍：
 * - 規則一：console.log placeholder
 * - 規則二：空 handler placeholder
 * - 規則三：上方 3 行 placeholder marker 文字
 * - 正常 handler（非 placeholder）
 * - 無 onClick 的 button
 * - 名稱提取（JSXText、aria-label、title）
 * - fuzzyFindComponent：完整 match、substring match、找不到
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { scanUiComponents, fuzzyFindComponent } from '../ui-component-scanner.ts';

// ─── 測試輔助 ────────────────────────────────────────────────────────────────

async function makeTmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'od-ui-scanner-test-'));
}

async function writeTsx(dir: string, filename: string, content: string): Promise<string> {
  const filePath = join(dir, filename);
  await writeFile(filePath, content, 'utf-8');
  return filePath;
}

// ─── 測試 Suite ───────────────────────────────────────────────────────────────

describe('scanUiComponents — 規則一：console.log placeholder', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('R1-A：arrow body 直接是 console.log(...)  → isPlaceholder=true', async () => {
    await writeTsx(tmpDir, 'Test.tsx', `
export function Test() {
  return (
    <button onClick={() => console.log('排程發布')}>排程發布</button>
  );
}
`);
    const result = await scanUiComponents(tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('排程發布');
    expect(result[0]!.isPlaceholder).toBe(true);
    expect(result[0]!.hasHandler).toBe(true);
    expect(result[0]!.type).toBe('button');
  });

  it('R1-B：block body 唯一 statement 是 console.log → isPlaceholder=true', async () => {
    await writeTsx(tmpDir, 'Test.tsx', `
export function Test() {
  return (
    <button onClick={() => { console.log('click'); }}>送出</button>
  );
}
`);
    const result = await scanUiComponents(tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0]!.isPlaceholder).toBe(true);
  });

  it('R1-C：console.log 含多個參數 → isPlaceholder=true', async () => {
    await writeTsx(tmpDir, 'Test.tsx', `
export function Test({ id }: { id: string }) {
  return (
    <button onClick={() => console.log('發布', id)}>發布</button>
  );
}
`);
    const result = await scanUiComponents(tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0]!.isPlaceholder).toBe(true);
  });
});

describe('scanUiComponents — 規則二：空 handler placeholder', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('R2-A：onClick={() => {}} → isPlaceholder=true', async () => {
    await writeTsx(tmpDir, 'Test.tsx', `
export function Test() {
  return (
    <button onClick={() => {}}>空按鈕</button>
  );
}
`);
    const result = await scanUiComponents(tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0]!.isPlaceholder).toBe(true);
  });
});

describe('scanUiComponents — 規則三：上方 3 行 placeholder marker', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('R3-A：title 含「即將推出」在當行（上方 0 行）→ isPlaceholder=true', async () => {
    // title 屬性在 onClick 的同一 JSXOpeningElement 中，
    // 我們的 marker 掃描的是上方 3 行，所以測試方式是把 comment 放在前 3 行
    await writeTsx(tmpDir, 'Test.tsx', `
export function Test() {
  return (
    <div>
      {/* coming-soon */}
      <button onClick={() => alert('x')}>功能按鈕</button>
    </div>
  );
}
`);
    const result = await scanUiComponents(tmpDir);
    const btn = result.find((c) => c.name === '功能按鈕');
    expect(btn).toBeDefined();
    expect(btn!.isPlaceholder).toBe(true);
  });

  it('R3-B：上方 1 行有 // to-do 註解 → isPlaceholder=true', async () => {
    await writeTsx(tmpDir, 'Test.tsx', `
export function Test() {
  return (
    <div>
      {/* to-do: implement handler */}
      <button onClick={() => alert('ok')}>動作</button>
    </div>
  );
}
`);
    const result = await scanUiComponents(tmpDir);
    const btn = result.find((c) => c.name === '動作');
    expect(btn).toBeDefined();
    expect(btn!.isPlaceholder).toBe(true);
  });

  it('R3-C：上方 3 行有 fix-me marker → isPlaceholder=true', async () => {
    await writeTsx(tmpDir, 'Test.tsx', `
export function Test() {
  return (
    <div>
      {/* fix-me */}
      <div>spacer 1</div>
      <div>spacer 2</div>
      <button onClick={() => doSomething()}>執行</button>
    </div>
  );
}
`);
    const result = await scanUiComponents(tmpDir);
    const btn = result.find((c) => c.name === '執行');
    expect(btn).toBeDefined();
    expect(btn!.isPlaceholder).toBe(true);
  });

  it('R3-D：上方 4 行有 marker（超出 3 行）→ isPlaceholder=false', async () => {
    await writeTsx(tmpDir, 'Test.tsx', `
export function Test() {
  async function handleReal() { await fetch('/api'); }
  return (
    <div>
      {/* coming-soon */}
      <div>行1</div>
      <div>行2</div>
      <div>行3</div>
      <button onClick={() => void handleReal()}>執行</button>
    </div>
  );
}
`);
    const result = await scanUiComponents(tmpDir);
    const btn = result.find((c) => c.name === '執行');
    expect(btn).toBeDefined();
    // 超出 3 行，不應算 placeholder
    expect(btn!.isPlaceholder).toBe(false);
  });

  it('R3-E：「即將推出」文字出現在 title 屬性同一行 → isPlaceholder=true（title 在 onClick 同元素）', async () => {
    // 利用 title attribute 含 "即將推出" 的場景模擬 TopBar 歷史按鈕：
    // title 和 onClick 在同一個 JSXOpeningElement，我們的規則掃描「上方 3 行」
    // 所以用 multiline JSXOpeningElement 讓 title 出現在 onClick 上方
    await writeTsx(tmpDir, 'TopBar.tsx', `
export function TopBar() {
  function showUnavailable(msg: string) { alert(msg); }
  return (
    <button
      type="button"
      aria-label="歷史"
      title="歷史功能即將推出"
      onClick={() => showUnavailable('歷史功能即將推出')}
    >
      History
    </button>
  );
}
`);
    const result = await scanUiComponents(tmpDir);
    const btn = result.find((c) => c.name === '歷史' || c.name === 'History');
    expect(btn).toBeDefined();
    // title 含「即將推出」在 onClick 上方 3 行內
    expect(btn!.isPlaceholder).toBe(true);
  });
});

describe('scanUiComponents — 正常 handler（非 placeholder）', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('H1：onClick 呼叫真實函式 → isPlaceholder=false', async () => {
    await writeTsx(tmpDir, 'Test.tsx', `
export function Test() {
  async function handlePublishNow() { await fetch('/api/publish'); }
  return (
    <button onClick={() => void handlePublishNow()}>立即發布</button>
  );
}
`);
    const result = await scanUiComponents(tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0]!.isPlaceholder).toBe(false);
    expect(result[0]!.hasHandler).toBe(true);
  });

  it('H2：onClick 是 function reference → isPlaceholder=false', async () => {
    await writeTsx(tmpDir, 'Test.tsx', `
export function Test({ onSave }: { onSave: () => void }) {
  return (
    <button onClick={onSave}>儲存</button>
  );
}
`);
    const result = await scanUiComponents(tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0]!.isPlaceholder).toBe(false);
  });
});

describe('scanUiComponents — 無 onClick 的 button', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('N1：沒有 onClick → hasHandler=false, isPlaceholder=false', async () => {
    await writeTsx(tmpDir, 'Test.tsx', `
export function Test() {
  return (
    <button type="submit">送出</button>
  );
}
`);
    const result = await scanUiComponents(tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0]!.hasHandler).toBe(false);
    expect(result[0]!.isPlaceholder).toBe(false);
  });
});

describe('scanUiComponents — 名稱提取', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('L1：從 JSXText children 取名稱', async () => {
    await writeTsx(tmpDir, 'Test.tsx', `
export function Test() {
  return <button onClick={() => {}}>我的按鈕</button>;
}
`);
    const result = await scanUiComponents(tmpDir);
    expect(result[0]!.name).toBe('我的按鈕');
  });

  it('L2：JSXText 為空時 fallback 到 aria-label', async () => {
    await writeTsx(tmpDir, 'Test.tsx', `
export function Test() {
  return <button aria-label="關閉" onClick={() => {}}><span>X</span></button>;
}
`);
    const result = await scanUiComponents(tmpDir);
    // JSXText children 為空（子元素是 JSXElement 非 JSXText），fallback 到 aria-label
    expect(result[0]!.name).toBe('關閉');
  });

  it('L3：無 JSXText 無 aria-label 時 fallback 到 title', async () => {
    await writeTsx(tmpDir, 'Test.tsx', `
export function Test() {
  return <button title="歷史" onClick={() => {}}><Icon /></button>;
}
`);
    const result = await scanUiComponents(tmpDir);
    expect(result[0]!.name).toBe('歷史');
  });
});

describe('fuzzyFindComponent', () => {
  const components = [
    {
      name: '排程發布',
      source: { file: 'a.tsx', line: 10 },
      type: 'button' as const,
      hasHandler: true,
      isPlaceholder: true,
    },
    {
      name: '立即發布',
      source: { file: 'b.tsx', line: 20 },
      type: 'button' as const,
      hasHandler: true,
      isPlaceholder: false,
    },
    {
      name: '儲存草稿',
      source: { file: 'c.tsx', line: 30 },
      type: 'button' as const,
      hasHandler: true,
      isPlaceholder: false,
    },
  ];

  it('F1：完整 name match（case-insensitive）→ 回傳正確元件', () => {
    const result = fuzzyFindComponent(components, '立即發布');
    expect(result).not.toBeNull();
    expect(result!.name).toBe('立即發布');
  });

  it('F2：substring match → 回傳含此字串的第一個元件', () => {
    const result = fuzzyFindComponent(components, '發布');
    // 排程發布 先出現
    expect(result).not.toBeNull();
    expect(result!.name).toBe('排程發布');
  });

  it('F3：找不到 → 回傳 null', () => {
    const result = fuzzyFindComponent(components, '付款');
    expect(result).toBeNull();
  });

  it('F4：空 components 陣列 → 回傳 null', () => {
    const result = fuzzyFindComponent([], '儲存');
    expect(result).toBeNull();
  });

  it('F5：case-insensitive match → 英文大小寫不影響結果', () => {
    const engComponents = [
      {
        name: 'Save Draft',
        source: { file: 'c.tsx', line: 30 },
        type: 'button' as const,
        hasHandler: true,
        isPlaceholder: false,
      },
    ];
    const result = fuzzyFindComponent(engComponents, 'save draft');
    expect(result).not.toBeNull();
    expect(result!.name).toBe('Save Draft');
  });
});
