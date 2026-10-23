import { parseRelationshipRouting } from '../model/relationship-routing';
/**
 * 概要 / 边界 / 关系线的新增、改名、删除。
 *
 * 三者合在一个文件里，因为它们共享同一套「选中一组主题 → 生成一个附属结构」
 * 的形状，而分开写会让三份几乎一样的查找与去重逻辑各长各的。
 *
 * 一个贯穿全文件的约定：**写入位置与读取位置必须一致**。`.xmind` 把边界与
 * 概要挂在主题上（`topic.boundaries` / `topic.summaries`），而画布级也各有一份
 * 扁平数组。读取侧（`collectBoundaries` / `collectSummaries`）两边都收，
 * 所以这里写哪一边都不会丢；新建一律写**画布级**——新建的边界/概要本来就没有
 * 天然的主人，硬塞给某个主题只会让删除主题时把它们一起带走。
 *
 * 关系线只有画布级一个位置（它不属于任何主题）。
 */

import { collectSummaries, findTopicInSheet } from '../model/traverse';
import type { Boundary, Relationship, Sheet, Style, Summary, RelationshipRouting } from '../model/types';
import { defineCommand, type EditorCommand } from './types';

export type AnnotationKind = 'summary' | 'boundary' | 'relationship';

const LABEL: Record<AnnotationKind, string> = {
  summary: '概要',
  boundary: '边界',
  relationship: '联系',
};

function sheetOf(draft: { sheets: Sheet[] }, sheetId: string): Sheet | undefined {
  return draft.sheets.find((sheet) => sheet.id === sheetId);
}

/**
 * 过滤掉不存在或重复的 id。
 *
 * 选中态是 `string[]`，它可能包含已经被删掉的节点（撤销 / 另一个标签页的
 * 改动），也可能因为框选顺序出现重复。带上无效 id 的 range 会让并集算不出来，
 * 表现是「点了没反应」。
 */
function cleanRange(sheet: Sheet, ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (findTopicInSheet(sheet, id) !== null) out.push(id);
  }
  return out;
}

export interface AddSummaryInput {
  /** 概要挂载主题，通常为选区的最近共同祖先。 */
  topicId: string;
  /** 被概要的全部选中主题。 */
  range: readonly string[];
  /** 概要节点上的文字。调用方负责给默认值（命令层不碰 i18n）。 */
  title: string;
}

/** 完整保留选区；挂载位置取所有选中项的最近共同祖先。 */
export function summaryTarget(sheet: Sheet, ids: readonly string[]): Omit<AddSummaryInput, 'title'> | null {
  const range = cleanRange(sheet, ids);
  if (range.length === 0) return null;
  const paths = range.map((id) => findTopicInSheet(sheet, id)!.path.slice(0, -1));
  const common = paths[0]!.filter((id, index) => paths.every((path) => path[index] === id));
  return { topicId: common.at(-1) ?? sheet.rootTopic.id, range };
}

/** 以集合而非选择顺序识别概要，兼容主题级导入数据。 */
export function summaryForRange(sheet: Sheet, range: readonly string[]): Summary | undefined {
  const ids = new Set(range);
  return collectSummaries(sheet).find((item) => {
    const existing = new Set(item.range);
    return existing.size === ids.size && [...existing].every((id) => ids.has(id));
  });
}

/** 新增概要。范围为空或父主题不存在时什么都不做。 */
export function addSummaryCommand(input: AddSummaryInput): EditorCommand {
  return defineCommand({
    type: 'annotation.addSummary',
    label: '新增概要',
    apply(draft, ctx) {
      const sheet = sheetOf(draft, ctx.sheetId);
      if (sheet === undefined) return;
      const parent = findTopicInSheet(sheet, input.topicId);
      if (parent === null) return;
      const range = cleanRange(sheet, input.range);
      if (range.length === 0) return;
      if (summaryForRange(sheet, range) !== undefined) return;
      const summary: Summary = {
        id: ctx.nextId(),
        topicId: input.topicId,
        range,
        title: input.title,
        style: null,
      };
      sheet.summaries.push(summary);
      // 父主题上留一份：XMind 就是这么存的，导出到 `.xmind` 时靠它，
      // 而且 `topic.summaries` 才是「这条概要属于谁」的权威记录。
      parent.topic.summaries.push({
        ...summary,
        range: [...summary.range],
      });
    },
  });
}

export interface AddBoundaryInput {
  /** 被边界覆盖的主题。 */
  range: readonly string[];
  title?: string;
}

/** 新增边界。 */
export function addBoundaryCommand(input: AddBoundaryInput): EditorCommand {
  return defineCommand({
    type: 'annotation.addBoundary',
    label: '新增边界',
    apply(draft, ctx) {
      const sheet = sheetOf(draft, ctx.sheetId);
      if (sheet === undefined) return;
      const range = cleanRange(sheet, input.range);
      if (range.length === 0) return;
      const boundary: Boundary = {
        id: ctx.nextId(),
        title: input.title ?? '',
        range,
        style: null,
      };
      sheet.boundaries.push(boundary);
    },
  });
}

export interface AddRelationshipInput {
  fromId: string;
  toId: string;
  title?: string;
}

/** 新增联系（关系线）。两端必须是两个不同的、存在的主题。 */
export function addRelationshipCommand(input: AddRelationshipInput): EditorCommand {
  return defineCommand({
    type: 'annotation.addRelationship',
    label: '新增联系',
    apply(draft, ctx) {
      const sheet = sheetOf(draft, ctx.sheetId);
      if (sheet === undefined) return;
      if (input.fromId === input.toId) return;
      if (findTopicInSheet(sheet, input.fromId) === null) return;
      if (findTopicInSheet(sheet, input.toId) === null) return;
      const relationship: Relationship = {
        id: ctx.nextId(),
        end1Id: input.fromId,
        end2Id: input.toId,
        title: input.title ?? '',
        style: null,
      };
      sheet.relationships.push(relationship);
    },
  });
}

/** 在三处（画布级 + 所有主题级）按 id 找，返回命中的对象。 */
function findAnnotation(
  sheet: Sheet,
  kind: AnnotationKind,
  id: string,
): { title: string } | null {
  if (kind === 'relationship') {
    return sheet.relationships.find((item) => item.id === id) ?? null;
  }
  if (kind === 'boundary') {
    const flat = sheet.boundaries.find((item) => item.id === id);
    if (flat !== undefined) return flat;
    for (const topic of flattenTopics(sheet)) {
      const hit = topic.boundaries.find((item) => item.id === id);
      if (hit !== undefined) return hit;
    }
    return null;
  }
  const flat = sheet.summaries.find((item) => item.id === id);
  if (flat !== undefined) return flat;
  for (const topic of flattenTopics(sheet)) {
    const hit = topic.summaries.find((item) => item.id === id);
    if (hit !== undefined) return hit;
  }
  return null;
}

function flattenTopics(sheet: Sheet) {
  const out: Sheet['rootTopic'][] = [];
  const stack = [sheet.rootTopic, ...sheet.floatingTopics];
  while (stack.length > 0) {
    const topic = stack.pop();
    if (topic === undefined) continue;
    out.push(topic);
    stack.push(...topic.children.attached, ...topic.children.detached);
  }
  return out;
}

/**
 * 改名。
 *
 * 连续输入合并成一条历史（与主题改名同一套 `coalesceKey`）：一边打字一边
 * 每次入栈，撤销就退化成退格键了。
 */
export function renameAnnotationCommand(kind: AnnotationKind, id: string, title: string): EditorCommand {
  const next = title.trim();
  return defineCommand({
    type: `annotation.rename.${kind}`,
    label: `重命名${LABEL[kind]}`,
    coalesceKey: `annotation:${kind}:${id}`,
    apply(draft, ctx) {
      const sheet = sheetOf(draft, ctx.sheetId);
      if (sheet === undefined || (next === '' && kind !== 'relationship')) return;
      // 两个落点都要改：只改一处的话，读取侧合并时先命中的那一份还是旧标题。
      if (kind === 'relationship') {
        const item = sheet.relationships.find((entry) => entry.id === id);
        if (item !== undefined) item.title = next;
        return;
      }
      if (kind === 'boundary') {
        for (const item of sheet.boundaries) if (item.id === id) item.title = next;
        for (const topic of flattenTopics(sheet)) {
          for (const item of topic.boundaries) if (item.id === id) item.title = next;
        }
        return;
      }
      for (const item of sheet.summaries) if (item.id === id) item.title = next;
      for (const topic of flattenTopics(sheet)) {
        for (const item of topic.summaries) if (item.id === id) item.title = next;
      }
    },
  });
}

/** 删除。两个落点一起删，不留孤儿。 */
export function removeAnnotationCommand(kind: AnnotationKind, id: string): EditorCommand {
  return defineCommand({
    type: `annotation.remove.${kind}`,
    label: `删除${LABEL[kind]}`,
    apply(draft, ctx) {
      const sheet = sheetOf(draft, ctx.sheetId);
      if (sheet === undefined) return;
      if (kind === 'relationship') {
        const index = sheet.relationships.findIndex((item) => item.id === id);
        if (index >= 0) sheet.relationships.splice(index, 1);
        return;
      }
      if (kind === 'boundary') {
        const index = sheet.boundaries.findIndex((item) => item.id === id);
        if (index >= 0) sheet.boundaries.splice(index, 1);
        for (const topic of flattenTopics(sheet)) {
          const at = topic.boundaries.findIndex((item) => item.id === id);
          if (at >= 0) topic.boundaries.splice(at, 1);
        }
        return;
      }
      const index = sheet.summaries.findIndex((item) => item.id === id);
      if (index >= 0) sheet.summaries.splice(index, 1);
      for (const topic of flattenTopics(sheet)) {
        const at = topic.summaries.findIndex((item) => item.id === id);
        if (at >= 0) topic.summaries.splice(at, 1);
      }
    },
  });
}

/** 读一条附属结构的标题；找不到返回空串（面板据此显示占位）。 */
export function annotationTitle(sheet: Sheet, kind: AnnotationKind, id: string): string {
  return findAnnotation(sheet, kind, id)?.title ?? '';
}

/** 联系样式补丁只写显式改动；undefined 删除覆盖值、恢复主题继承。 */
export function updateRelationshipStyleCommand(id: string, patch: Partial<Style>): EditorCommand {
  return defineCommand({
    type: 'annotation.style.relationship',
    label: '修改联系样式',
    apply(draft, ctx) {
      const item = sheetOf(draft, ctx.sheetId)?.relationships.find((entry) => entry.id === id);
      if (!item) return;
      const current = item.style ?? {};
      const keys = Object.keys(patch) as (keyof Style)[];
      if (!keys.some((key) => patch[key] === undefined ? key in current : patch[key] !== current[key])) return;
      const next = { ...current } as Record<string, unknown>;
      for (const key of keys) {
        if (patch[key] === undefined) delete next[key];
        else next[key] = patch[key];
      }
      item.style = next as Partial<Style>;
    },
  });
}

/** 拖动仅在松手后落入历史；null 恢复自动走向。 */
export function updateRelationshipRoutingCommand(id: string, routing: RelationshipRouting | null, curve = false): EditorCommand {
  return defineCommand({
    type: 'annotation.routing.relationship', label: '调整联系走向',
    apply(draft, ctx) {
      const item = sheetOf(draft, ctx.sheetId)?.relationships.find((entry) => entry.id === id);
      if (!item) return;
      if (routing === null) { delete item.routing; return; }
      const parsed = parseRelationshipRouting(routing);
      if (!parsed) return;
      item.routing = parsed;
      if (curve) item.style = { ...item.style, lineStyle: 'curve' };
    },
  });
}
