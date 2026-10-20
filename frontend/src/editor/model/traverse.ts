/**
 * 文档遍历工具。
 *
 * 全部是纯函数、不改入参。传入 immer draft 时同样可用——draft 是 Proxy，
 * 读语义与普通对象一致，因此命令实现可以直接拿 `findTopic` 的结果做原地修改。
 *
 * 复杂度约定：`findTopic` / `findPath` 是 O(n) 全树扫描（n = 单画布节点数）。
 * 需要频繁按 id 取节点时（命中测试、拖拽落点）调用方应自己建 Map，
 * 这里不维护索引——文档是 immer 不可变结构，索引一改就得整体重建，
 * 反而比按需扫描更容易出错。
 */

import type { Sheet, Topic, WmindDocument } from './types';

export interface WalkContext {
  depth: number;
  /** 在兄弟中的下标；根节点为 0。 */
  index: number;
  /**
   * 一级分支序号，决定调色板取色。
   *
   * 根与自由主题为 -1；根的直接子节点为自己的下标；更深的节点继承祖先的
   * 分支序号——「同一分支同一色系」就是这么实现的。在遍历时逐层传递而不是
   * 反查父链，把 O(depth) 降到 O(1)。
   */
  branchIndex: number;
  parent: Topic | null;
  /** 从根到当前节点的 id 路径（含自身）。 */
  path: string[];
  /** 是否为自由主题（不属于 rootTopic 子树）。 */
  isFloating: boolean;
}

/**
 * 访问者。返回 `false` 表示**不再下钻**该节点的子树（节点本身已访问过），
 * 不是中止整次遍历——两者语义差别很大，别混。
 */
export type TopicVisitor = (topic: Topic, ctx: WalkContext) => void | false;

/** 深度优先遍历一棵子树。 */
export function walkTopic(root: Topic, visit: TopicVisitor, isFloating = false): void {
  visitNode(
    root,
    { depth: 0, index: 0, branchIndex: -1, parent: null, path: [root.id], isFloating },
    visit,
  );
}

function visitNode(topic: Topic, ctx: WalkContext, visit: TopicVisitor): void {
  const result = visit(topic, ctx);
  if (result === false) return;
  const children = topic.children.attached;
  for (let i = 0; i < children.length; i += 1) {
    const child = children[i];
    if (!child) continue;
    visitNode(
      child,
      {
        depth: ctx.depth + 1,
        index: i,
        branchIndex: ctx.depth === 0 ? i : ctx.branchIndex,
        parent: topic,
        path: [...ctx.path, child.id],
        isFloating: ctx.isFloating,
      },
      visit,
    );
  }
}

/**
 * 遍历一张画布：先根树，再自由主题。
 *
 * 自由主题的 `depth` 记为 1、`parent` 为 null —— 它们视觉上是根的子级，
 * 但不属于树结构，`parent` 必须为 null，否则拖拽改父级会算错。
 */
export function walkSheet(sheet: Sheet, visit: TopicVisitor): void {
  walkTopic(sheet.rootTopic, visit);
  for (let i = 0; i < sheet.floatingTopics.length; i += 1) {
    const floating = sheet.floatingTopics[i];
    if (!floating) continue;
    visitNode(
      floating,
      { depth: 1, index: i, branchIndex: -1, parent: null, path: [floating.id], isFloating: true },
      visit,
    );
  }
}

export interface FoundTopic {
  topic: Topic;
  parent: Topic | null;
  sheet: Sheet;
  depth: number;
  index: number;
  branchIndex: number;
  path: string[];
  isFloating: boolean;
}

function makeFound(topic: Topic, sheet: Sheet, ctx: WalkContext): FoundTopic {
  return {
    topic,
    parent: ctx.parent,
    sheet,
    depth: ctx.depth,
    index: ctx.index,
    branchIndex: ctx.branchIndex,
    path: ctx.path,
    isFloating: ctx.isFloating,
  };
}

/** 在单张画布里按 id 找节点。 */
export function findTopicInSheet(sheet: Sheet, id: string): FoundTopic | null {
  let found: FoundTopic | null = null;
  walkSheet(sheet, (topic, ctx) => {
    if (topic.id === id) {
      found = makeFound(topic, sheet, ctx);
      return false;
    }
    return found ? false : undefined;
  });
  return found;
}

/** 在整份文档里按 id 找节点。找不到返回 null。 */
export function findTopic(doc: WmindDocument, id: string): FoundTopic | null {
  for (const sheet of doc.sheets) {
    const found = findTopicInSheet(sheet, id);
    if (found) return found;
  }
  return null;
}

/** 从根到目标节点的路径（含两端）。找不到返回空数组。 */
export function findPath(doc: WmindDocument, id: string): Topic[] {
  const found = findTopic(doc, id);
  return found ? resolvePath(found.sheet, found.path) : [];
}

/** 把 id 路径解析成节点数组。根路径与自由主题路径用同一套循环。 */
export function resolvePath(sheet: Sheet, path: readonly string[]): Topic[] {
  const out: Topic[] = [];
  const first = path[0];
  if (!first) return out;

  let current: Topic | undefined = first === sheet.rootTopic.id
    ? sheet.rootTopic
    : sheet.floatingTopics.find((t) => t.id === first);
  if (!current) return out;

  for (let i = 0; i < path.length; i += 1) {
    const id = path[i];
    if (!current || current.id !== id) break;
    out.push(current);
    const nextId = path[i + 1];
    current = nextId ? current.children.attached.find((t) => t.id === nextId) : undefined;
  }
  return out;
}

/** 整份文档的节点总数（所有画布、含自由主题）。 */
export function countNodes(doc: WmindDocument): number {
  let total = 0;
  for (const sheet of doc.sheets) {
    walkSheet(sheet, () => {
      total += 1;
    });
  }
  return total;
}

/**
 * 单张画布的节点数（含自由主题及其后代）。
 *
 * 页脚显示的是**当前画布**的数量：多画布之后「整份文档 1200 个节点」既解释
 * 不了当前视野里那 8 个框，也帮不上任何忙。要总数的地方（列表、配额）用
 * `countNodes`。
 */
export function countSheetNodes(sheet: Sheet): number {
  let total = 1 + countDescendants(sheet.rootTopic);
  for (const floating of sheet.floatingTopics) {
    total += 1 + countDescendants(floating);
  }
  return total;
}

export interface FlatTopic {
  id: string;
  title: string;
  depth: number;
  index: number;
  branchIndex: number;
  parentId: string | null;
  path: string[];
  isFloating: boolean;
  collapsed: boolean;
  childCount: number;
  /** 折叠时被隐藏的后代总数（含多层）。展开时为 0。 */
  hiddenChildren: number;
}

/** 摊平成数组，供列表类 UI（大纲、查找结果）使用。 */
export function flatten(doc: WmindDocument, sheetId?: string): FlatTopic[] {
  const out: FlatTopic[] = [];
  for (const sheet of doc.sheets) {
    if (sheetId && sheet.id !== sheetId) continue;
    walkSheet(sheet, (topic, ctx) => {
      out.push({
        id: topic.id,
        title: topic.title,
        depth: ctx.depth,
        index: ctx.index,
        branchIndex: ctx.branchIndex,
        parentId: ctx.parent?.id ?? null,
        path: ctx.path,
        isFloating: ctx.isFloating,
        collapsed: topic.collapsed,
        childCount: topic.children.attached.length,
        hiddenChildren: topic.collapsed ? countDescendants(topic) : 0,
      });
    });
  }
  return out;
}

/** 后代总数（含多层，含 detached）。 */
export function countDescendants(topic: Topic): number {
  let total = 0;
  const stack: Topic[] = [...topic.children.attached, ...topic.children.detached];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    total += 1;
    stack.push(...current.children.attached, ...current.children.detached);
  }
  return total;
}

/**
 * `id` 是否为 `ancestor` 的后代（含 detached 分支）。
 *
 * 拖拽合法性靠它：把节点拖进自己的后代会让整棵子树从文档里消失，
 * 这是唯一一种「操作成功但内容丢失」的破坏性编辑。
 */
export function isDescendant(ancestor: Topic, id: string): boolean {
  const stack: Topic[] = [...ancestor.children.attached, ...ancestor.children.detached];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    if (current.id === id) return true;
    stack.push(...current.children.attached, ...current.children.detached);
  }
  return false;
}

/** 当前可见的节点 id 集合：折叠节点的子树整体不可见，但折叠节点自身可见。 */
export function visibleIds(sheet: Sheet): Set<string> {
  const ids = new Set<string>();
  walkSheet(sheet, (topic) => {
    ids.add(topic.id);
    return topic.collapsed ? false : undefined;
  });
  return ids;
}

/** 某节点的兄弟数组（含自身）；根返回单元素数组，自由主题返回自由主题数组。 */
export function siblingList(sheet: Sheet, id: string): Topic[] {
  const found = findTopicInSheet(sheet, id);
  if (!found) return [];
  if (!found.parent) {
    return found.isFloating ? sheet.floatingTopics : [sheet.rootTopic];
  }
  return found.parent.children.attached;
}

/** 默认画布（第一张）。文档至少一张画布，所以不会返回 undefined。 */
export function firstSheet(doc: WmindDocument): Sheet {
  const sheet = doc.sheets[0];
  if (!sheet) throw new Error('文档至少需要一张画布');
  return sheet;
}

/** 按 id 取画布，取不到时回落到第一张。 */
export function sheetById(doc: WmindDocument, sheetId: string | null): Sheet {
  if (!sheetId) return firstSheet(doc);
  return doc.sheets.find((s) => s.id === sheetId) ?? firstSheet(doc);
}
