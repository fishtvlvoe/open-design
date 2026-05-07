/**
 * spectra-exporter adapter — 單元測試
 *
 * 覆蓋範圍：
 * 1. generateCandidateNames：中文 → kebab-case 三個候選
 * 2. exportSpectraChange（mock subprocess）：驗證寫了三個 artifact 檔案
 * 3. openspec 缺失時拋出正確錯誤訊息
 */

import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockedFunction,
} from 'vitest';

import { generateCandidateNames, exportSpectraChange } from '../index.ts';
import type { ExportInput } from '../../codebase-scanner/types.ts';

// ─── 測試輔助 ────────────────────────────────────────────────────────────────

async function makeTmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'od-exporter-test-'));
}

/** 建立最小 mock ConnectionMap */
function mockInput(overrides?: Partial<ExportInput>): ExportInput {
  return {
    changeName: 'wire-schedule-publish',
    targetProject: '',  // 由各測試覆寫
    connectionMap: {
      connections: [
        {
          from: {
            name: 'PublishNodeCard',
            source: { file: 'apps/web/src/components/PublishNodeCard.tsx', line: 125 },
            type: 'button',
            hasHandler: false,
            isPlaceholder: true,
          },
          to: {
            method: 'POST',
            path: '/api/publish/schedule',
            source: { file: 'apps/api/src/routes/publish-schedule.ts', line: 1 },
            framework: 'express',
          },
          status: 'missing',
        },
      ],
    },
    ...overrides,
  };
}

// ─── Mock child_process.spawn ─────────────────────────────────────────────────

// 記錄所有 spawn 呼叫，用來驗證三件套都被呼叫
const spawnCalls: Array<{ args: string[] }> = [];

vi.mock('node:child_process', () => {
  return {
    spawn: vi.fn((_cmd: string, args: string[]) => {
      spawnCalls.push({ args: [...args] });

      // 模擬 EventEmitter-like 子程序
      const handlers: Record<string, Array<(...a: unknown[]) => void>> = {
        data: [],
        close: [],
        error: [],
      };

      const mockStdout = {
        on: (event: string, cb: (...a: unknown[]) => void) => {
          if (event === 'data') handlers['data']!.push(cb);
        },
      };
      const mockStderr = {
        on: (_event: string, _cb: (...a: unknown[]) => void) => {/* noop */},
      };
      const mockStdin = {
        write: (_data: string, _enc: string) => {/* noop */},
        end: () => {
          // 寫完 stdin 後，模擬 close exit 0
          setTimeout(() => {
            handlers['close']!.forEach(cb => cb(0));
          }, 0);
        },
      };

      // analyze --json：回傳空陣列
      if (args.includes('analyze')) {
        setTimeout(() => {
          handlers['data']!.forEach(cb => cb(Buffer.from('[]', 'utf-8')));
        }, 0);
      }

      return {
        stdout: mockStdout,
        stderr: mockStderr,
        stdin: mockStdin,
        on: (event: string, cb: (...a: unknown[]) => void) => {
          if (event === 'close') handlers['close']!.push(cb);
          if (event === 'error') handlers['error']!.push(cb);
        },
      };
    }),
  };
});

// ─── Test Suites ─────────────────────────────────────────────────────────────

describe('generateCandidateNames', () => {
  it('中文「排程發布銜接」→ 三個 kebab-case 候選', () => {
    const [c1, c2, c3] = generateCandidateNames('排程發布銜接');
    // 每個候選必須是合法 kebab-case（純小寫英文 + 數字 + 連字號）
    const kebab = /^[a-z0-9]+(-[a-z0-9]+)*$/;
    expect(c1).toMatch(kebab);
    expect(c2).toMatch(kebab);
    expect(c3).toMatch(kebab);
    // 三個候選不完全相同（至少兩個不同）
    const unique = new Set([c1, c2, c3]);
    expect(unique.size).toBeGreaterThanOrEqual(2);
  });

  it('中文「修下單按鈕」→ 包含 fix 或 checkout 相關詞', () => {
    const candidates = generateCandidateNames('修下單按鈕');
    const joined = candidates.join(' ');
    expect(joined).toMatch(/fix|checkout|button|order/);
  });

  it('中文「加會員登入」→ 包含 add 或 member 或 login 相關詞', () => {
    const candidates = generateCandidateNames('加會員登入');
    const joined = candidates.join(' ');
    expect(joined).toMatch(/add|member|login|auth/);
  });

  it('純英文輸入直接通過（不崩潰）', () => {
    const [c1] = generateCandidateNames('add-payment-api');
    expect(c1).toMatch(/^[a-z0-9-]+$/);
  });
});

describe('exportSpectraChange', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
    // 建立 openspec/changes/
    await mkdir(join(tmpDir, 'openspec', 'changes'), { recursive: true });
    // 清空 spawn 呼叫記錄
    spawnCalls.length = 0;
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('成功路徑：呼叫三個 spectra new artifact 子程序（proposal / design / tasks）', async () => {
    const input = mockInput({ targetProject: tmpDir });
    const result = await exportSpectraChange(input);

    // 驗證回傳的 files 有三個
    expect(result.files).toHaveLength(3);

    // 驗證 changeName 正確帶回
    expect(result.changeName).toBe('wire-schedule-publish');

    // 驗證 spawn 被呼叫過（proposal + design + tasks + validate + analyze = 5 次）
    const artifactCalls = spawnCalls.filter(c => c.args.includes('artifact'));
    expect(artifactCalls).toHaveLength(3);

    // 驗證三種 type 都被呼叫
    const types = artifactCalls.map(c => {
      const idx = c.args.indexOf('artifact');
      return c.args[idx + 1];
    });
    expect(types).toContain('proposal');
    expect(types).toContain('design');
    expect(types).toContain('tasks');
  });

  it('validate 步驟被呼叫', async () => {
    const input = mockInput({ targetProject: tmpDir });
    await exportSpectraChange(input);

    const validateCalls = spawnCalls.filter(c => c.args.includes('validate'));
    expect(validateCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('analyze 步驟被呼叫，findings 為陣列', async () => {
    const input = mockInput({ targetProject: tmpDir });
    const result = await exportSpectraChange(input);

    const analyzeCalls = spawnCalls.filter(c => c.args.includes('analyze'));
    expect(analyzeCalls.length).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(result.analyzeFindings)).toBe(true);
  });

  it('openspec 不存在時拋出正確錯誤訊息', async () => {
    const noOpenspecDir = await makeTmpDir();  // 沒有建 openspec/
    const input = mockInput({ targetProject: noOpenspecDir });

    await expect(exportSpectraChange(input)).rejects.toThrow('沒有 openspec/ 目錄');
    await rm(noOpenspecDir, { recursive: true, force: true });
  });
});
