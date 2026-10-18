/**
 * 主题（节点）相关命令。
 *
 * 所有命令都假定 `ctx.sheetId` 指向的画布存在——store 保证这一点，
 * 命令内部不再兜底：如果画布都不在了，那是调用方的状态机出了问题，
 * 静默失败会让 bug 藏得更深。
 */

import { createTopic } from '../model/create';
import { cloneTopic } from '../model/clone';
import {
  countDescendants,
  findTopic,
  isDescendant,
  walkSheet,
} from '../model/traverse';
import type { Sheet, Topic, WmindDocument } from '../model/types';
import { defineCommand, type CommandResult, type EditorCommand } from './types';

/** 从父数组里摘掉一个节点。返回是否真的摘掉了。 */
function detachFromParent(sheet: Sheet, found: NonNullable<ReturnType<typeof findTopic>>): boolean {
  if (found.isFloating) {
    const index = sheet.floatingTopics.findIndex((t) => t.id === found.topic.id);
    if (index < 0) return false;
    sheet.floatingTopics.splice(index, 1);
    return true;
  }
  if (!found.parent) return false; // 根节点不能摘
  const siblings = found.parent.children.attached;
  const index = siblings.findIndex((t) => t.id === found.topic.id);
  if (index < 0) return false;
  siblings.splice(index, 1);
  return true;
}

/** 收集子树里所有节点 id（含自身）。 */
function collectIds(topic: Topic, out: Set<string> = new Set()): Set<string> {
  out.add(topic.id);
  for (const child of topic.children.attached) collectIds(child, out);
  for (const child of topic.children.detached) collectIds(child, out);
  return out;
}

/**
 * 清理指向已删除节点的附属结构。
 *
 * 不做这一步会留下「悬空关系」：渲染层按 id 查不到端点，要么抛错，
 * 要么画出半条线。清理放在删除命令里，而不是渲染时跳过——
 * 悬空数据会随着保存写回后端，越积越多。
 */
function purgeReferences(sheet: Sheet, removed: Set<string>): void {
  sheet.relationships = sheet.relationships.filter(
    (r) => !removed.has(r.end1Id) && !removed.has(r.end2Id),
  );
  sheet.boundaries = sheet.boundaries
    .map((b) => ({ ...b, range: b.range.filter((id) => !removed.has(id)) }))
    .filter((b) => b.range.length > 0);
  sheet.summaries = sheet.summaries
    .map((s) => ({ ...s, range: s.range.filter((id) => !removed.has(id)) }))
    .filter((s) => s.range.length > 0 && !removed.has(s.topicId));

  walkSheet(sheet, (topic) => {
    if (topic.boundaries.length > 0) {
      topic.boundaries = topic.boundaries
        .map((b) => ({ ...b, range: b.range.filter((id) => !removed.has(id)) }))
        .filter((b) => b.range.length > 0);
    }
    if (topic.summaries.length > 0) {
      topic.summaries = topic.summaries
        .map((s) => ({ ...s, range: s.range.filter((id) => !removed.has(id)) }))
        .filter((s) => s.range.length > 0);
    }
  });
}

/** 新建子主题。父节点若处于折叠态会自动展开——否则新节点创建完就看不见。 */
export function addChildCommand(parentId: string, title = ''): EditorCommand {
  return defineCommand({
    type: 'topic.add',
    label: '新建子主题',
    apply(draft, ctx): CommandResult | void {
      const found = findTopic(draft, parentId);
      if (!found) return;
      const topic = createTopic({ id: ctx.nextId(), title });
      found.topic.collapsed = false;
      found.topic.children.attached.push(topic);
      return { select: [topic.id], edit: true };
    },
  });
}

/**
 * 新建同级主题，插在当前节点之后。
 *
 * 根节点没有同级，按 XMind 的惯例退化为「新建子主题」——否则在根上按
 * Enter 什么都不会发生，用户会以为键盘坏了。
 */
export function addSiblingCommand(siblingId: string, title = ''): EditorCommand {
  return defineCommand({
    type: 'topic.add-sibling',
    label: '新建同级主题',
    apply(draft, ctx): CommandResult | void {
      const found = findTopic(draft, siblingId);
      if (!found) return;

      const topic = createTopic({ id: ctx.nextId(), title });
      if (found.isFloating) {
        found.sheet.floatingTopics.splice(found.index + 1, 0, topic);
      } else if (found.parent) {
        found.parent.children.attached.splice(found.index + 1, 0, topic);
      } else {
        found.topic.collapsed = false;
        found.topic.children.attached.push(topic);
      }
      return { select: [topic.id], edit: true };
    },
  });
}

/** 删除一组主题及其子树。根节点不可删。 */
export function removeTopicsCommand(ids: readonly string[]): EditorCommand {
  return defineCommand({
    type: 'topic.remove',
    label: ids.length > 1 ? `删除 ${ids.length} 个主题` : '删除主题',
    apply(draft): CommandResult | void {
      const removed = new Set<string>();
      let sheet: Sheet | null = null;
      let parentId: string | null = null;

      for (const id of ids) {
        const found = findTopic(draft, id);
        if (!found) continue;
        // 根节点是整个画布的锚，删掉它文档就空了。折叠成「不可删」而不是
        // 自动换个根——后者会让用户丢失整棵树的上下文。
        if (!found.parent && !found.isFloating) continue;
        collectIds(found.topic, removed);
        parentId = found.parent?.id ?? null;
        sheet = found.sheet;
        detachFromParent(found.sheet, found);
      }

      if (removed.size === 0 || !sheet) return;
      purgeReferences(sheet, removed);
      return { select: parentId ? [parentId] : [] };
    },
  });
}

/** 改名。连续输入由 store 按 `coalesceKey` 合并成一条历史。 */
export function renameTopicCommand(id: string, title: string): EditorCommand {
  return defineCommand({
    type: 'topic.rename',
    label: '重命名',
    coalesceKey: `rename:${id}`,
    apply(draft): void {
      const found = findTopic(draft, id);
      if (!found) return;
      found.topic.title = title;
    },
  });
}

/** 设置折叠状态。 */
export function setCollapsedCommand(id: string, collapsed: boolean): EditorCommand {
  return defineCommand({
    type: 'topic.collapse',
    label: collapsed ? '折叠分支' : '展开分支',
    apply(draft): void {
      const found = findTopic(draft, id);
      if (!found) return;
      // 空节点折叠没有意义，而且会让「折叠数字」显示 0 看着像坏了。
      if (collapsed && countDescendants(found.topic) === 0) return;
      found.topic.collapsed = collapsed;
    },
  });
}

export function toggleCollapseCommand(id: string): EditorCommand {
  return defineCommand({
    type: 'topic.toggle-collapse',
    label: '折叠 / 展开',
    apply(draft): CommandResult | void {
      const found = findTopic(draft, id);
      if (!found) return;
      if (!found.topic.collapsed && countDescendants(found.topic) === 0) return;
      found.topic.collapsed = !found.topic.collapsed;
      // 折叠后如果选中的是后代，选中态会指向看不见的节点。
      // 把选中收回到被折叠的节点上。
      return found.topic.collapsed ? { select: [found.topic.id] } : undefined;
    },
  });
}

/**
 * 去掉「祖先也在被拖集合里」的节点。
 *
 * 框选很容易同时选中父节点和它的子节点。如果两个都搬，子节点会被父节点
 * 带进新位置，然后再单独插一遍——同一棵子树在文档里出现两份。
 */
function topLevelOnly(draft: WmindDocument, ids: readonly string[]): string[] {
  const set = new Set(ids);
  return ids.filter((id) => {
    let found = findTopic(draft, id);
    while (found?.parent) {
      if (set.has(found.parent.id)) return false;
      found = findTopic(draft, found.parent.id);
    }
    return true;
  });
}

/**
 * 移动一组主题到新的父节点下。
 *
 * 批量版本单独写而不是循环调用单节点版本，是为了让「一次拖拽 = 一条历史」。
 * 循环 dispatch 会产生 N 条撤销记录，用户按一次 Ctrl+Z 只退回去一个节点，
 * 看起来像撤销坏了。
 *
 * 实现上是「先全部摘下来，再按给定顺序插进去」。顺序很重要：如果边摘边插，
 * 后续节点的目标下标会随着数组变短而错位——这类 off-by-one 在多选拖拽里
 * 特别难复现（单节点永远是对的）。
 *
 * 合法性：目标不能是自身或任何被拖节点的后代。这不是防御性编程，而是必须的——
 * 把子树挂到自己下面会让这棵子树从文档里彻底消失（既不在根树里，也不在
 * 自由主题里），用户的所有内容就丢了。非法时整批拒绝，不做「能动的先动」。
 */
export function moveTopicsCommand(
  ids: readonly string[],
  newParentId: string,
  index?: number,
): EditorCommand {
  return defineCommand({
    type: 'topic.move',
    label: ids.length > 1 ? `移动 ${ids.length} 个主题` : '移动主题',
    apply(draft): CommandResult | void {
      const target = findTopic(draft, newParentId);
      // 自由主题没有子树语义，不能当父节点。
      if (!target || target.isFloating) return;

      const moving: Topic[] = [];
      for (const id of topLevelOnly(draft, ids)) {
        if (id === newParentId) return;
        const found = findTopic(draft, id);
        if (!found) continue;
        if (!found.parent) return; // 根与自由主题不参与移动
        if (isDescendant(found.topic, newParentId)) return;
        moving.push(found.topic);
      }
      if (moving.length === 0) return;

      for (const id of moving.map((topic) => topic.id)) {
        const found = findTopic(draft, id);
        if (found?.parent) detachFromParent(found.sheet, found);
      }

      const siblings = target.topic.children.attached;
      const at = index === undefined ? siblings.length : Math.max(0, Math.min(index, siblings.length));
      target.topic.collapsed = false;
      siblings.splice(at, 0, ...moving);
      return { select: moving.map((topic) => topic.id) };
    },
  });
}

/** 移动单个主题。 */
export function moveTopicCommand(id: string, newParentId: string, index?: number): EditorCommand {
  return moveTopicsCommand([id], newParentId, index);
}

/**
 * 拖到画布空白处：脱离树结构，变成自由主题。
 *
 * 批量版本同样是为了「一次拖拽 = 一条历史」。
 */
export function detachTopicsCommand(ids: readonly string[]): EditorCommand {
  return defineCommand({
    type: 'topic.detach',
    label: ids.length > 1 ? `${ids.length} 个主题转为自由主题` : '转为自由主题',
    apply(draft): CommandResult | void {
      const moved: Topic[] = [];
      for (const id of topLevelOnly(draft, ids)) {
        const found = findTopic(draft, id);
        if (!found) continue;
        if (!found.parent) continue; // 根与已是自由主题的节点不动
        const topic = found.topic;
        detachFromParent(found.sheet, found);
        found.sheet.floatingTopics.push(topic);
        moved.push(topic);
      }
      if (moved.length === 0) return;
      return { select: moved.map((topic) => topic.id) };
    },
  });
}

export function detachTopicCommand(id: string): EditorCommand {
  return detachTopicsCommand([id]);
}

/** 粘贴：把外部（或复制的）子树挂到目标节点下，全部换新 id。 */
export function pasteTopicsCommand(parentId: string, topics: readonly Topic[]): EditorCommand {
  return defineCommand({
    type: 'topic.paste',
    label: topics.length > 1 ? `粘贴 ${topics.length} 个主题` : '粘贴主题',
    apply(draft, ctx): CommandResult | void {
      const found = findTopic(draft, parentId);
      if (!found || found.isFloating || topics.length === 0) return;

      const pasted = topics.map((topic) =>
        cloneTopic(topic, { nextId: ctx.nextId, keepCollapsed: false }),
      );
      found.topic.collapsed = false;
      found.topic.children.attached.push(...pasted);
      return { select: pasted.map((t) => t.id) };
    },
  });
}
