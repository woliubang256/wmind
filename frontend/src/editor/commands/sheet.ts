/**
 * 画布级命令：新增、重命名、删除、排序。
 *
 * 与 `document.ts` 分开：那边改的是整份文档（标题、结构、整份替换），
 * 这边只动 `doc.sheets` 这个数组本身。
 *
 * **切换画布不在这里**——它不是文档变更，是视图状态，见 store 的 `setSheet`。
 * 如果做成命令，撤销栈里会堆满「切到画布 2」这种记录，用户按 ⌘Z 想撤销的
 * 显然不是它。
 *
 * 一条贯穿全文件的约束：**文档至少保留一张画布**。删除命令在只剩一张时
 * 什么都不改（immer 返回原引用，store 会判定为空操作，既不进历史也不标脏）。
 */

import { createSheet } from '../model/create';
import type { Sheet, StructureClass } from '../model/types';
import { defineCommand, type EditorCommand } from './types';

/** 完整复制画布；先分配 ID，再修复引用，包含主题级与画布级附属结构。 */
export function copySheetCommand(source: Sheet, id: string, title: string, afterId: string): EditorCommand {
  const snapshot = structuredClone(source);
  return defineCommand({
    type: 'sheet.copy',
    label: '复制画布',
    apply(draft, ctx): void {
      if (draft.sheets.some((sheet) => sheet.id === id)) return;
      const copy = structuredClone(snapshot);
      const ids = new Map<string, string>();
      const topics: Sheet['rootTopic'][] = [];
      const collect = (topic: Sheet['rootTopic']) => {
        topics.push(topic);
        topic.children.attached.forEach(collect);
        topic.children.detached.forEach(collect);
      };
      collect(copy.rootTopic);
      copy.floatingTopics.forEach(collect);
      const summaries = [...copy.summaries, ...topics.flatMap((topic) => topic.summaries)];
      const boundaries = [...copy.boundaries, ...topics.flatMap((topic) => topic.boundaries)];
      for (const item of [...topics, ...summaries, ...boundaries, ...copy.relationships]) {
        if (!ids.has(item.id)) ids.set(item.id, ctx.nextId());
      }
      const remap = (old: string) => ids.get(old) ?? old;
      for (const topic of topics) {
        topic.id = remap(topic.id);
        if (topic.href.startsWith('xmind:#')) topic.href = `xmind:#${remap(topic.href.slice(7))}`;
      }
      for (const item of [...summaries, ...boundaries]) {
        item.id = remap(item.id);
        item.range = item.range.map(remap);
      }
      for (const summary of summaries) summary.topicId = remap(summary.topicId);
      for (const relationship of copy.relationships) {
        relationship.id = remap(relationship.id);
        relationship.end1Id = remap(relationship.end1Id);
        relationship.end2Id = remap(relationship.end2Id);
      }
      copy.id = id;
      copy.title = title;
      const index = draft.sheets.findIndex((sheet) => sheet.id === afterId);
      draft.sheets.splice(index < 0 ? draft.sheets.length : index + 1, 0, copy);
    },
  });
}

export interface AddSheetInput {
  /** 由调用方生成：它需要在派发之后立刻切到这张新画布。 */
  id: string;
  title: string;
  /** 新画布沿用当前画布的结构——「再加一张同类型的图」是最常见的意图。 */
  structure?: StructureClass;
}

/** 新增一张画布，追加到末尾。 */
export function addSheetCommand(input: AddSheetInput): EditorCommand {
  return defineCommand({
    type: 'sheet.add',
    label: '新建画布',
    apply(draft): void {
      // 中心主题留默认文案而不是画布名：画布名是导航标签，中心主题是内容，
      // 混成一个会让「重命名画布」看起来像改了图里的字。
      draft.sheets.push(
        createSheet({
          id: input.id,
          title: input.title,
          structure: input.structure ?? 'mindmap',
        }),
      );
    },
  });
}

/**
 * 重命名画布。
 *
 * 只改 `sheet.title`，不碰中心主题（见上面 `addSheetCommand` 的注释）。
 * 空白名视为无效：它会让标签变成一个点不中的窄条，用户既找不到也点不开。
 */
export function renameSheetCommand(sheetId: string, title: string): EditorCommand {
  const next = title.trim();
  return defineCommand({
    type: 'sheet.rename',
    label: '重命名画布',
    // 连续改名（一边输一边改）合并成一条历史，否则每敲一个字都是一次撤销点。
    coalesceKey: `sheet:${sheetId}`,
    apply(draft): void {
      if (next === '') return;
      const sheet = draft.sheets.find((s) => s.id === sheetId);
      if (!sheet || sheet.title === next) return;
      sheet.title = next;
    },
  });
}

/**
 * 删除画布。
 *
 * 画布上的节点、自由主题、关系线、外框、概要全都随画布一起消失——所以
 * 界面在画布有内容时会先要一次确认（空的直接删，撤销随时可以救回来）。
 */
export function removeSheetCommand(sheetId: string): EditorCommand {
  return defineCommand({
    type: 'sheet.remove',
    label: '删除画布',
    apply(draft): void {
      if (draft.sheets.length <= 1) return;
      const index = draft.sheets.findIndex((s) => s.id === sheetId);
      if (index < 0) return;
      draft.sheets.splice(index, 1);
    },
  });
}

/**
 * 把画布移到指定下标（拖拽排序与「左移 / 右移」共用）。
 *
 * 越界一律夹到合法区间而不是报错：拖拽的落点由 DOM 算出来，画布数在拖的
 * 过程中可能已经变了（比如另一处删了一张），夹一下比抛错稳。
 */
export function moveSheetCommand(sheetId: string, toIndex: number): EditorCommand {
  return defineCommand({
    type: 'sheet.move',
    label: '调整画布顺序',
    apply(draft): void {
      const from = draft.sheets.findIndex((s) => s.id === sheetId);
      if (from < 0) return;
      const to = Math.max(0, Math.min(draft.sheets.length - 1, toIndex));
      if (to === from) return;
      const [sheet] = draft.sheets.splice(from, 1);
      if (!sheet) return;
      draft.sheets.splice(to, 0, sheet);
    },
  });
}

/** 画布上是否还有内容（除中心主题之外）。决定删除要不要二次确认。 */
export function sheetHasContent(sheet: Sheet): boolean {
  if (sheet.rootTopic.children.attached.length > 0) return true;
  if (sheet.rootTopic.children.detached.length > 0) return true;
  if (sheet.floatingTopics.length > 0) return true;
  if (sheet.relationships.length > 0 || sheet.boundaries.length > 0 || sheet.summaries.length > 0) {
    return true;
  }
  return false;
}
