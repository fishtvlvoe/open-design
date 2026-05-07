/**
 * UI Component Scanner
 *
 * 掃描 React .tsx / .jsx 檔案，找出 <button onClick={...}> 元素，
 * 並以啟發式規則判斷每個按鈕是否為 placeholder（待實作狀態）。
 *
 * 判斷邏輯：
 * 1. onClick body 只有 `console.log(...)` → isPlaceholder = true
 * 2. onClick body 為空 `() => {}` 或空 block → isPlaceholder = true
 * 3. onClick 上方 3 行內有含 `to-do` / `fix-me` / `coming-soon` / `即將推出`
 *    的 JSXText 或 single-line comment → isPlaceholder = true
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import glob from 'fast-glob';
import { parse as babelParse } from '@babel/parser';
import type {
  File,
  JSXOpeningElement,
  JSXAttribute,
  Expression,
  ArrowFunctionExpression,
  BlockStatement,
  CallExpression,
  JSXElement,
  Node,
} from '@babel/types';
import type { UiComponent } from './types.ts';
import { maybeCachedParse, ScannerCache, setActiveCache } from './cache.ts';

/** Wave 7：cache namespace */
const UI_CACHE_NAMESPACE = 'ui-component';

// ─── 公開 API ─────────────────────────────────────────────────────────────────

/**
 * 遞迴掃描 rootDir 底下所有 .tsx / .jsx 檔案，
 * 回傳找到的 UiComponent 陣列（只含 <button onClick> 元素）。
 */
export async function scanUiComponents(rootDir: string): Promise<UiComponent[]> {
  const absRoot = resolve(rootDir);

  // 取得所有目標檔案
  const files = await glob('**/*.{tsx,jsx}', {
    cwd: absRoot,
    absolute: true,
    ignore: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/build/**',
      '**/out/**',
      '**/coverage/**',
      '**/__tests__/**',
      '**/*.test.*',
      '**/*.spec.*',
    ],
  });

  // Wave 7：若呼叫端未先 setActiveCache，這裡自己開一個 ad-hoc cache 管理生命週期
  // （讓單獨呼叫 scanUiComponents 也享受 cache 加速）
  const { getActiveCache } = await import('./cache.ts');
  const externallyManaged = getActiveCache() !== null;
  let ownedCache: ScannerCache | null = null;
  if (!externallyManaged) {
    ownedCache = await ScannerCache.load(absRoot);
    setActiveCache(ownedCache);
  }

  try {
    // 平行解析，逐檔掃描（內部 parseFileForComponents 會走 cache）
    const results = await Promise.all(
      files.map((file) => parseFileForComponents(file)),
    );
    return results.flat();
  } finally {
    if (ownedCache !== null) {
      try {
        await ownedCache.save();
      } finally {
        setActiveCache(null);
      }
    }
  }
}

/**
 * Fuzzy 搜尋元件名稱。
 * 優先順序：完整 name match → substring → 找不到回 null。
 * 全程 case-insensitive。
 */
export function fuzzyFindComponent(
  components: UiComponent[],
  query: string,
): UiComponent | null {
  if (components.length === 0 || query.length === 0) return null;

  const q = query.toLowerCase();

  // 1. 完整 match
  const exact = components.find((c) => c.name.toLowerCase() === q);
  if (exact !== undefined) return exact;

  // 2. Substring match（先找）
  const sub = components.find((c) => c.name.toLowerCase().includes(q));
  if (sub !== undefined) return sub;

  // 3. 找不到
  return null;
}

// ─── 內部實作 ─────────────────────────────────────────────────────────────────

/** 解析單一檔案並回傳找到的 UiComponent 列表。解析失敗時靜默回傳空陣列。 */
async function parseFileForComponents(filePath: string): Promise<UiComponent[]> {
  // Wave 7：走 mtime cache，命中時直接回 cached UiComponent[]
  return maybeCachedParse<UiComponent[]>(
    filePath,
    UI_CACHE_NAMESPACE,
    () => parseFileForComponentsImpl(filePath),
  );
}

/** 實際解析邏輯（cache miss 時呼叫） */
async function parseFileForComponentsImpl(filePath: string): Promise<UiComponent[]> {
  let source: string;
  try {
    source = await readFile(filePath, 'utf-8');
  } catch {
    return [];
  }

  let ast: File;
  try {
    ast = babelParse(source, {
      sourceType: 'module',
      plugins: ['typescript', 'jsx'],
      errorRecovery: true,
    });
  } catch {
    return [];
  }

  const lines = source.split('\n');
  const components: UiComponent[] = [];

  // 用遞迴 walker 走訪 AST
  walkNode(ast, (node) => {
    if (node.type !== 'JSXElement') return;

    const element = node as JSXElement;
    const opening = element.openingElement as JSXOpeningElement;

    // 只處理 <button ...>
    if (
      opening.name.type !== 'JSXIdentifier' ||
      opening.name.name !== 'button'
    ) {
      return;
    }

    // 找 onClick attribute
    const onClickAttr = opening.attributes.find(
      (attr): attr is JSXAttribute =>
        attr.type === 'JSXAttribute' &&
        attr.name.type === 'JSXIdentifier' &&
        attr.name.name === 'onClick',
    );

    const hasHandler = onClickAttr !== undefined;
    const line = opening.loc?.start.line ?? 1;

    // 取得按鈕文字標籤
    const name = extractButtonLabel(element, opening);

    // 判斷是否為 placeholder
    const isPlaceholder = hasHandler
      ? judgeIsPlaceholder(onClickAttr!, lines)
      : false;

    components.push({
      name,
      source: { file: filePath, line },
      type: 'button',
      hasHandler,
      isPlaceholder,
    });
  });

  return components;
}

/**
 * 從 JSXElement 提取可辨識的按鈕名稱。
 * 優先順序：
 * 1. JSXText children 合併（去頭尾空白）
 * 2. aria-label attribute
 * 3. title attribute
 * 4. fallback 到空字串
 */
function extractButtonLabel(
  element: JSXElement,
  opening: JSXOpeningElement,
): string {
  // 1. JSXText children
  const texts: string[] = [];
  for (const child of element.children) {
    if (child.type === 'JSXText') {
      const trimmed = child.value.trim();
      if (trimmed.length > 0) texts.push(trimmed);
    }
  }
  if (texts.length > 0) return texts.join(' ');

  // 2. aria-label
  const ariaLabel = findStringAttribute(opening, 'aria-label');
  if (ariaLabel !== null) return ariaLabel;

  // 3. title
  const title = findStringAttribute(opening, 'title');
  if (title !== null) return title;

  return '';
}

/** 取出 JSXAttribute 上的字串 literal 值（只取 StringLiteral，不處理 JSXExpressionContainer） */
function findStringAttribute(
  opening: JSXOpeningElement,
  attrName: string,
): string | null {
  const attr = opening.attributes.find(
    (a): a is JSXAttribute =>
      a.type === 'JSXAttribute' &&
      a.name.type === 'JSXIdentifier' &&
      a.name.name === attrName,
  );

  if (attr === undefined || attr.value === null || attr.value === undefined) return null;

  if (attr.value.type === 'StringLiteral') {
    return attr.value.value;
  }

  return null;
}

/**
 * 啟發式判斷：此 onClick 是否為 placeholder。
 *
 * 規則一：onClick body 只有 `console.log(...)` 呼叫
 * 規則二：onClick body 為空 `() => {}` 或空 block
 * 規則三：onClick 屬性所在行上方 3 行內有含 placeholder marker 的文字
 *         （含 onClick 所在行本身，因為 title 屬性可能與 onClick 同行或在上方）
 */
function judgeIsPlaceholder(
  attr: JSXAttribute,
  lines: readonly string[],
): boolean {
  // onClick 屬性自身所在行（1-indexed）
  const onClickLine = attr.loc?.start.line ?? 1;

  // 取出 onClick 的 handler expression
  const value = attr.value;
  if (value === null || value === undefined) return false;

  if (value.type === 'JSXExpressionContainer') {
    const expr = value.expression;

    if (expr.type === 'ArrowFunctionExpression') {
      const arrow = expr as ArrowFunctionExpression;

      // 規則一：body 是 CallExpression 且 callee 是 console.log
      if (arrow.body.type === 'CallExpression') {
        if (isConsoleLog(arrow.body)) return true;
      }

      // 規則二：body 是空 BlockStatement
      if (arrow.body.type === 'BlockStatement') {
        const block = arrow.body as BlockStatement;
        if (block.body.length === 0) return true;

        // 規則一 + 二：block 只有一條 ExpressionStatement 且是 console.log
        if (
          block.body.length === 1 &&
          block.body[0]!.type === 'ExpressionStatement'
        ) {
          const stmt = block.body[0]!;
          if (
            stmt.type === 'ExpressionStatement' &&
            stmt.expression.type === 'CallExpression' &&
            isConsoleLog(stmt.expression)
          ) {
            return true;
          }
        }
      }
    }
  }

  // 規則三：以 onClick 屬性所在行為基準，往上掃 3 行（含該行本身）
  // lines 陣列是 0-indexed，onClickLine 是 1-indexed
  // checkStart 含 onClick 行（允許同行的 title 屬性觸發規則）
  const checkStart = Math.max(0, onClickLine - 1 - 3); // 往上 3 行
  const checkEnd = onClickLine; // 含 onClick 所在行（exclusive，但 +1 所以含）
  const PLACEHOLDER_RE = /to-do|fix-me|coming-soon|即將推出/i;

  for (let i = checkStart; i < checkEnd; i++) {
    const lineText = lines[i] ?? '';
    if (PLACEHOLDER_RE.test(lineText)) return true;
  }

  return false;
}

/** 判斷 CallExpression 是否為 `console.log(...)` */
function isConsoleLog(call: CallExpression): boolean {
  const callee = call.callee;
  if (callee.type !== 'MemberExpression') return false;
  const obj = callee.object;
  const prop = callee.property;
  return (
    obj.type === 'Identifier' &&
    obj.name === 'console' &&
    prop.type === 'Identifier' &&
    prop.name === 'log'
  );
}

/**
 * 簡易遞迴 AST walker。
 * 對每個 node 呼叫 visitor，沒有回傳值（副作用式）。
 */
function walkNode(node: Node | null | undefined, visitor: (n: Node) => void): void {
  if (node === null || node === undefined || typeof node !== 'object') return;
  if (typeof (node as Node).type !== 'string') return;

  visitor(node as Node);

  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'loc' || key === 'start' || key === 'end') continue;
    const child = (node as unknown as Record<string, unknown>)[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        walkNode(item as Node | null | undefined, visitor);
      }
    } else if (child !== null && typeof child === 'object') {
      walkNode(child as Node | null | undefined, visitor);
    }
  }
}
