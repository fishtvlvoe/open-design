/**
 * Wave 10 整合測試 runner — 跑 5 個真實專案，輸出 JSON 摘要。
 * 用法：node ../../node_modules/.bin/tsx __tests__/wave10-runner.ts
 */
import { scanProject, scanUiComponents } from '../index.ts';

const projects: Array<{ name: string; path: string }> = [
  { name: 'FlowGo', path: '/Users/fishtv/Development/products/flowgo' },
  { name: 'MOLTOS', path: '/Users/fishtv/Development/products/摩托斯MOLTOS' },
  { name: 'BuyGo+1', path: '/Users/fishtv/Development/8-外掛/buygo-plus-one' },
  { name: 'inkgo', path: '/Users/fishtv/Development/99-舊-archives/inkgo' },
  { name: 'three-ai', path: '/Users/fishtv/Development/2-顧問/real-estate-AI/three-ai' },
];

for (const { name, path } of projects) {
  const t0 = Date.now();
  try {
    const result = await scanProject(path);
    let components: any[] = [];
    try {
      components = await scanUiComponents(path);
    } catch (e) {
      // 非 React/Vue 專案不重要
    }
    const ms = Date.now() - t0;
    const methods = result.apis.reduce<Record<string, number>>((acc, a) => {
      acc[a.method] = (acc[a.method] ?? 0) + 1;
      return acc;
    }, {});
    console.log(JSON.stringify({
      project: name,
      path,
      ok: true,
      ms,
      techStack: result.techStack,
      apiCount: result.apis.length,
      methodBreakdown: methods,
      componentCount: components.length,
      sampleApis: result.apis.slice(0, 5).map(a => `${a.method} ${a.path}`),
      sampleComponents: components.slice(0, 5).map((c: any) => c.name),
    }, null, 2));
  } catch (e: any) {
    console.log(JSON.stringify({
      project: name,
      path,
      ok: false,
      error: e?.message ?? String(e),
    }, null, 2));
  }
  console.log('---');
}
