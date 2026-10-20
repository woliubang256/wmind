/**
 * 节点 id 的查重与引用修正。
 *
 * XMind 的 id 在同一文档里可能重复（复制粘贴、合并文件、模板复用都会产生），
 * 而 `parseDocument` 查重时会**换掉** id —— 那样 `relationships` / `boundaries`
 * / `summaries` 里的引用就全指向不存在的老 id 了。
 *
 * 所以解析阶段就要自己建「原 id → 写入文档的 id」映射：冲突的后来者换新 id，
 * 但引用仍然指向前者——用户拖出来的联系线连着的是先画的那个节点。
 *
 * 现代格式（`content.json`）与 XMind 8（`content.xml`）用的是同一套语义，
 * 因此这段逻辑抽出来共用，而不是各写一遍再慢慢跑偏。
 */

import type { ImportContext } from '../types';

/** 登记一个新 id，返回它在文档里实际使用的值。 */
export function claimId(
  raw: unknown,
  ctx: ImportContext,
  ids: Map<string, string>,
  used: Set<string>,
): string {
  const original = typeof raw === 'string' ? raw : '';
  if (original !== '' && !used.has(original)) {
    used.add(original);
    ids.set(original, original);
    return original;
  }
  const fresh = ctx.ids.topic();
  used.add(fresh);
  // 只记第一次出现的映射：后来同名节点的引用应该指向前者。
  if (original !== '' && !ids.has(original)) ids.set(original, fresh);
  return fresh;
}

/** XMind 的 range 可能是 `"(a,b)"`、`"a"` 或数组。 */
export function parseRange(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.filter((item): item is string => typeof item === 'string' && item !== '');
  }
  if (typeof raw !== 'string') return [];
  return raw
    .replace(/^\(|\)$/g, '')
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

/** 把引用里的老 id 换成新 id；指向不存在节点的引用直接丢掉。 */
export function remapRange(raw: unknown, ids: ReadonlyMap<string, string>): string[] {
  const out: string[] = [];
  for (const id of parseRange(raw)) {
    const mapped = ids.get(id);
    if (mapped !== undefined && !out.includes(mapped)) out.push(mapped);
  }
  return out;
}
