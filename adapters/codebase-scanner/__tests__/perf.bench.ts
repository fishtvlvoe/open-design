/**
 * Wave 7 — Performance benchmark（手動執行，非 CI 必跑）
 *
 * 用法：
 *   cd adapters/codebase-scanner
 *   npx tsx __tests__/perf.bench.ts <project-root>
 *
 * 預期目標：
 * - FlowGo (約 3,000 檔)：首次 < 15 秒、增量 < 5 秒
 * - 5,000 檔案專案：首次 < 30 秒
 *
 * 流程：
 * 1. 第一次跑 scanProject（冷啟動）— 記錄時間
 * 2. 第二次跑 scanProject（暖啟動，重用 cache）— 記錄時間
 * 3. 印出 cache hits / misses 統計
 *
 * 注意：腳本不會清除 .open-design/scanner-cache.json，
 * 想跑「真.冷啟動」測試請先手動 rm 該檔。
 */

import { performance } from 'node:perf_hooks';
import { scanProject } from '../index.ts';

async function main(): Promise<void> {
  const target = process.argv[2];
  if (target === undefined) {
    console.error('Usage: tsx perf.bench.ts <project-root>');
    process.exit(1);
  }

  console.log(`Target: ${target}\n`);

  // 第一次掃描
  const t0 = performance.now();
  const r1 = await scanProject(target);
  const dt1 = performance.now() - t0;
  console.log(
    `[1st scan] ${(dt1 / 1000).toFixed(2)}s  apis=${r1.apis.length}  components=${r1.components.length}  techStack=[${r1.techStack.join(',')}]`,
  );

  // 第二次掃描（重用 cache）
  const t1 = performance.now();
  const r2 = await scanProject(target);
  const dt2 = performance.now() - t1;
  console.log(
    `[2nd scan] ${(dt2 / 1000).toFixed(2)}s  apis=${r2.apis.length}  components=${r2.components.length}`,
  );

  // 加速比
  const speedup = dt1 / dt2;
  console.log(`\nSpeedup: ${speedup.toFixed(1)}x`);
  console.log(
    `\nExpected: 1st < 30s (5,000 檔), 2nd < 5s (no changes). FlowGo 約 3,000 檔目標 1st < 15s.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
