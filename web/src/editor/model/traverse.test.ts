import { describe, expect, it } from 'vitest';
import {
  countDescendants,
  countNodes,
  findPath,
  findTopic,
  flatten,
  isDescendant,
  resolvePath,
  siblingList,
  visibleIds,
  walkSheet,
  walkTopic,
} from './traverse';
import { docWithTree } from '../test-utils';

describe('walkSheet', () => {
  it('先根树、再自由主题，深度与父节点正确', () => {
    const doc = docWithTree();
    const seen: { id: string; depth: number; parent: string | null; floating: boolean }[] = [];
    walkSheet(doc.sheets[0]!, (t, ctx) => {
      seen.push({ id: t.id, depth: ctx.depth, parent: ctx.parent?.id ?? null, floating: ctx.isFloating });
    });

    expect(seen).toEqual([
      { id: 'root', depth: 0, parent: null, floating: false },
      { id: 'a', depth: 1, parent: 'root', floating: false },
      { id: 'a1', depth: 2, parent: 'a', floating: false },
      { id: 'a2', depth: 2, parent: 'a', floating: false },
      { id: 'a2x', depth: 3, parent: 'a2', floating: false },
      { id: 'b', depth: 1, parent: 'root', floating: false },
      { id: 'b1', depth: 2, parent: 'b', floating: false },
      // 自由主题的 parent 必须是 null：它视觉上像根的子级，但不在树里，
      // 否则拖拽改父级会把它算成根的子树。
      { id: 'f1', depth: 1, parent: null, floating: true },
      { id: 'f1x', depth: 2, parent: 'f1', floating: true },
    ]);
  });

  it('branchIndex 在一级分支上按下标分配，后代继承', () => {
    const doc = docWithTree();
    const branch = new Map<string, number>();
    walkSheet(doc.sheets[0]!, (t, ctx) => {
      branch.set(t.id, ctx.branchIndex);
    });

    expect(branch.get('root')).toBe(-1);
    expect(branch.get('a')).toBe(0);
    expect(branch.get('a1')).toBe(0);
    expect(branch.get('a2x')).toBe(0);
    expect(branch.get('b')).toBe(1);
    expect(branch.get('b1')).toBe(1);
    expect(branch.get('f1')).toBe(-1);
  });

  it('访问者返回 false 时不再下钻，但继续访问兄弟', () => {
    const doc = docWithTree();
    const ids: string[] = [];
    walkSheet(doc.sheets[0]!, (t) => {
      ids.push(t.id);
      return t.id === 'a2' ? false : undefined;
    });

    // a2x 被剪掉，b 仍然访问到。
    expect(ids).toEqual(['root', 'a', 'a1', 'a2', 'b', 'b1', 'f1', 'f1x']);
  });
});

describe('walkTopic', () => {
  it('单棵子树的路径与下标正确', () => {
    const doc = docWithTree();
    const paths: string[][] = [];
    walkTopic(doc.sheets[0]!.rootTopic, (_t, ctx) => {
      paths.push(ctx.path);
    });
    expect(paths).toContainEqual(['root', 'a', 'a2', 'a2x']);
  });
});

describe('findTopic / findPath', () => {
  it('能找到深节点并给出完整上下文', () => {
    const doc = docWithTree();
    const found = findTopic(doc, 'a2x');
    expect(found).not.toBeNull();
    expect(found!.depth).toBe(3);
    expect(found!.parent?.id).toBe('a2');
    expect(found!.path).toEqual(['root', 'a', 'a2', 'a2x']);
    expect(found!.isFloating).toBe(false);
  });

  it('自由主题的 parent 为 null 且标记 isFloating', () => {
    const doc = docWithTree();
    const found = findTopic(doc, 'f1x');
    expect(found!.isFloating).toBe(true);
    expect(found!.parent?.id).toBe('f1');
    expect(found!.path).toEqual(['f1', 'f1x']);
  });

  it('找不到时返回 null / 空数组', () => {
    const doc = docWithTree();
    expect(findTopic(doc, 'nope')).toBeNull();
    expect(findPath(doc, 'nope')).toEqual([]);
  });

  it('findPath 返回从根到目标的节点序列', () => {
    const doc = docWithTree();
    expect(findPath(doc, 'b1').map((t) => t.id)).toEqual(['root', 'b', 'b1']);
  });

  it('resolvePath 能解析自由主题路径', () => {
    const doc = docWithTree();
    expect(resolvePath(doc.sheets[0]!, ['f1', 'f1x']).map((t) => t.id)).toEqual(['f1', 'f1x']);
  });
});

describe('计数与可见性', () => {
  it('countNodes 统计所有画布含自由主题', () => {
    expect(countNodes(docWithTree())).toBe(9);
  });

  it('countDescendants 含多层与 detached', () => {
    const doc = docWithTree();
    const a = findTopic(doc, 'a')!.topic;
    expect(countDescendants(a)).toBe(3); // a1, a2, a2x
  });

  it('visibleIds 跳过折叠节点的子树', () => {
    const ids = visibleIds(docWithTree().sheets[0]!);
    expect(ids.has('a2')).toBe(true);
    expect(ids.has('a2x')).toBe(false);
  });

  it('flatten 只在折叠时给出 hiddenChildren', () => {
    const flat = flatten(docWithTree());
    const a2 = flat.find((f) => f.id === 'a2');
    const a1 = flat.find((f) => f.id === 'a1');
    expect(a2?.hiddenChildren).toBe(1);
    expect(a2?.collapsed).toBe(true);
    expect(a1?.hiddenChildren).toBe(0);
  });

  it('flatten 可按画布过滤', () => {
    expect(flatten(docWithTree(), 'nope')).toHaveLength(0);
    expect(flatten(docWithTree(), 'sh-1')).toHaveLength(9);
  });
});

describe('isDescendant / siblingList', () => {
  it('识别后代（含多层）', () => {
    const doc = docWithTree();
    const a = findTopic(doc, 'a')!.topic;
    expect(isDescendant(a, 'a2x')).toBe(true);
    expect(isDescendant(a, 'b1')).toBe(false);
    expect(isDescendant(a, 'a')).toBe(false); // 自己不是自己的后代
  });

  it('siblingList 对树节点返回父的 attached，对自由主题返回 floatingTopics', () => {
    const doc = docWithTree();
    const sheet = doc.sheets[0]!;
    expect(siblingList(sheet, 'a1').map((t) => t.id)).toEqual(['a1', 'a2']);
    expect(siblingList(sheet, 'f1').map((t) => t.id)).toEqual(['f1']);
    expect(siblingList(sheet, 'root').map((t) => t.id)).toEqual(['root']);
    expect(siblingList(sheet, 'nope')).toEqual([]);
  });
});
