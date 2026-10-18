import { describe, expect, it } from 'vitest';
import { createEditorStore } from './editor-store';
import { addChildCommand, addSiblingCommand, moveTopicCommand, pasteTopicsCommand, removeTopicsCommand, renameTopicCommand, toggleCollapseCommand } from '../commands/topic';
import { findTopic } from '../model/traverse';
import { deterministicIds, docWithTree } from '../test-utils';
import type { WmindDocument } from '../model/types';

interface Harness {
  store: ReturnType<typeof createEditorStore>;
  advance: (ms: number) => void;
}

function makeStore(doc: WmindDocument = docWithTree(), options: { historyLimit?: number } = {}): Harness {
  let clock = 1_000;
  const store = createEditorStore({
    doc,
    now: () => clock,
    nextId: deterministicIds('new'),
    ...options,
  });
  return { store, advance: (ms) => { clock += ms; } };
}

describe('dispatch', () => {
  it('新建子主题后选中并进入编辑态', () => {
    const { store } = makeStore();
    store.getState().dispatch(addChildCommand('a', ''));

    const state = store.getState();
    const parent = findTopic(state.doc, 'a')!;
    expect(parent.topic.children.attached).toHaveLength(3);
    expect(state.selection).toEqual(['new-1']);
    expect(state.editingId).toBe('new-1');
    expect(state.past).toHaveLength(1);
    expect(state.save.status).toBe('dirty');
    expect(state.revision).toBe(1);
  });

  it('每次成功命令都推进 meta.updatedAt', () => {
    const { store, advance } = makeStore();
    const before = store.getState().doc.meta.updatedAt;
    advance(60_000);
    store.getState().dispatch(addChildCommand('a'));
    expect(store.getState().doc.meta.updatedAt).not.toBe(before);
  });

  it('空操作不进历史（删除根节点）', () => {
    const { store } = makeStore();
    store.getState().dispatch(removeTopicsCommand(['root']));
    const state = store.getState();
    expect(state.past).toHaveLength(0);
    expect(state.revision).toBe(0);
  });

  it('折叠空节点也是空操作', () => {
    const { store } = makeStore();
    store.getState().dispatch(toggleCollapseCommand('a1'));
    expect(store.getState().past).toHaveLength(0);
  });

  it('新建同级插在当前节点之后；根节点退化为新建子主题', () => {
    const { store } = makeStore();
    store.getState().dispatch(addSiblingCommand('a1'));
    expect(store.getState().doc.sheets[0]!.rootTopic.children.attached[0]!.children.attached.map((t) => t.id))
      .toEqual(['a1', 'new-1', 'a2']);

    store.getState().dispatch(addSiblingCommand('root'));
    expect(store.getState().doc.sheets[0]!.rootTopic.children.attached.map((t) => t.id))
      .toEqual(['a', 'b', 'new-2']);
  });
});

describe('撤销与重做', () => {
  it('撤销回到上一状态，重做再前进', () => {
    const { store } = makeStore();
    store.getState().dispatch(addChildCommand('a'));
    expect(findTopic(store.getState().doc, 'new-1')).not.toBeNull();

    store.getState().undo();
    expect(findTopic(store.getState().doc, 'new-1')).toBeNull();
    expect(store.getState().past).toHaveLength(0);
    expect(store.getState().future).toHaveLength(1);

    store.getState().redo();
    expect(findTopic(store.getState().doc, 'new-1')).not.toBeNull();
    expect(store.getState().future).toHaveLength(0);
  });

  it('撤销后执行新命令会清空重做栈', () => {
    const { store } = makeStore();
    store.getState().dispatch(addChildCommand('a'));
    store.getState().undo();
    store.getState().dispatch(addChildCommand('b'));
    expect(store.getState().future).toHaveLength(0);
  });

  it('撤销恢复选中态', () => {
    const { store } = makeStore();
    store.getState().select(['b1']);
    store.getState().dispatch(addChildCommand('a'));
    expect(store.getState().selection).toEqual(['new-1']);
    store.getState().undo();
    expect(store.getState().selection).toEqual(['b1']);
  });

  it('空栈时撤销 / 重做是安全的空操作', () => {
    const { store } = makeStore();
    expect(() => {
      store.getState().undo();
      store.getState().redo();
    }).not.toThrow();
  });
});

describe('历史栈', () => {
  it('连续改名在时间窗口内合并为一条历史', () => {
    const { store } = makeStore();
    store.getState().dispatch(renameTopicCommand('a', 'A1'));
    store.getState().dispatch(renameTopicCommand('a', 'A2'));
    store.getState().dispatch(renameTopicCommand('a', 'A3'));

    expect(store.getState().past).toHaveLength(1);
    expect(findTopic(store.getState().doc, 'a')!.topic.title).toBe('A3');

    store.getState().undo();
    // 合并后的三条改名是一个撤销单元：一次撤销回到「开始打字之前」，
    // 而不是逐个字符回退。这正是 coalesce 的意义。
    expect(findTopic(store.getState().doc, 'a')!.topic.title).toBe('A');
  });

  it('超过合并窗口后重新入栈', () => {
    const { store, advance } = makeStore();
    store.getState().dispatch(renameTopicCommand('a', 'A1'));
    advance(900);
    store.getState().dispatch(renameTopicCommand('a', 'A2'));
    expect(store.getState().past).toHaveLength(2);
  });

  it('不同节点的改名不合并', () => {
    const { store } = makeStore();
    store.getState().dispatch(renameTopicCommand('a', 'A1'));
    store.getState().dispatch(renameTopicCommand('b', 'B1'));
    expect(store.getState().past).toHaveLength(2);
  });

  it('改成相同标题是空操作', () => {
    const { store } = makeStore();
    store.getState().dispatch(renameTopicCommand('a', 'A'));
    expect(store.getState().past).toHaveLength(0);
  });

  it('超出上限时丢弃最旧的记录', () => {
    const { store } = makeStore(docWithTree(), { historyLimit: 3 });
    for (let i = 0; i < 6; i += 1) {
      store.getState().dispatch(addChildCommand('a'));
    }
    expect(store.getState().past).toHaveLength(3);
  });
});

describe('删除与移动的完整性', () => {
  it('删除节点会清理指向它的关系 / 边界 / 汇总', () => {
    const doc = docWithTree();
    doc.sheets[0]!.relationships.push({
      id: 'r1',
      end1Id: 'a',
      end2Id: 'b1',
      title: '',
      style: null,
    });
    doc.sheets[0]!.boundaries.push({ id: 'b1', title: '', range: ['b1'], style: null });

    const { store } = makeStore(doc);
    store.getState().dispatch(removeTopicsCommand(['b']));

    const sheet = store.getState().doc.sheets[0]!;
    expect(findTopic(store.getState().doc, 'b')).toBeNull();
    expect(sheet.relationships).toEqual([]);
    expect(sheet.boundaries).toEqual([]);
  });

  it('删除后选中回到父节点', () => {
    const { store } = makeStore();
    store.getState().dispatch(removeTopicsCommand(['b1']));
    expect(store.getState().selection).toEqual(['b']);
  });

  it('拒绝把节点移到自己的后代下', () => {
    const { store } = makeStore();
    const before = store.getState().doc;
    store.getState().dispatch(moveTopicCommand('a', 'a1'));
    expect(store.getState().doc).toBe(before);
    expect(store.getState().past).toHaveLength(0);
  });

  it('拒绝把节点移到自身下', () => {
    const { store } = makeStore();
    const before = store.getState().doc;
    store.getState().dispatch(moveTopicCommand('a', 'a'));
    expect(store.getState().doc).toBe(before);
  });

  it('移动成功后顺序正确', () => {
    const { store } = makeStore();
    store.getState().dispatch(moveTopicCommand('b1', 'a'));
    const a = findTopic(store.getState().doc, 'a')!;
    expect(a.topic.children.attached.map((t) => t.id)).toEqual(['a1', 'a2', 'b1']);
  });

  it('粘贴会重新生成 id，不产生重复', () => {
    const { store } = makeStore();
    const source = findTopic(store.getState().doc, 'a')!.topic;
    store.getState().dispatch(pasteTopicsCommand('b', [source]));

    const pasted = findTopic(store.getState().doc, 'b')!.topic.children.attached;
    const ids = new Set<string>();
    for (const t of pasted) ids.add(t.id);
    expect(ids.has('a')).toBe(false);
    expect(pasted).toHaveLength(2); // 原有的 b1 + 粘贴的
  });
});

describe('选中态', () => {
  it('toggleSelect 增删', () => {
    const { store } = makeStore();
    store.getState().toggleSelect('a');
    store.getState().toggleSelect('b');
    expect(store.getState().selection).toEqual(['a', 'b']);
    store.getState().toggleSelect('a');
    expect(store.getState().selection).toEqual(['b']);
    store.getState().clearSelection();
    expect(store.getState().selection).toEqual([]);
  });
});

describe('loadDocument', () => {
  it('替换文档并清空历史与选中', () => {
    const { store } = makeStore();
    store.getState().dispatch(addChildCommand('a'));
    const next = docWithTree();
    next.id = 'doc-2';

    store.getState().loadDocument(next);
    const state = store.getState();
    expect(state.doc.id).toBe('doc-2');
    expect(state.past).toEqual([]);
    expect(state.future).toEqual([]);
    expect(state.selection).toEqual([]);
    expect(state.revision).toBe(0);
  });
});

describe('保存状态', () => {
  it('markSaved：期间没有新编辑才置为已保存', () => {
    const { store } = makeStore();
    store.getState().dispatch(addChildCommand('a'));
    const revision = store.getState().revision;

    store.getState().markSaved(2, revision);
    expect(store.getState().save.status).toBe('saved');
    expect(store.getState().version).toBe(2);
  });

  it('markSaved：期间又编辑过则仍是未保存，但版本号必须采纳', () => {
    const { store } = makeStore();
    store.getState().dispatch(addChildCommand('a'));
    const revisionAtStart = store.getState().revision;
    store.getState().dispatch(addChildCommand('a'));

    store.getState().markSaved(2, revisionAtStart);
    // 显示「已保存」而实际有没落盘的改动，是最坏的一种谎。
    expect(store.getState().save.status).toBe('dirty');
    // 版本号不采纳的话，下一次保存必然 409。
    expect(store.getState().version).toBe(2);
  });

  it('markConflict 记录服务器版本，编辑不会把它打回 dirty', () => {
    const { store } = makeStore();
    store.getState().markConflict(7, '2026-10-18T10:00:00Z');
    expect(store.getState().save.status).toBe('conflict');
    expect(store.getState().save.conflict).toEqual({ version: 7, updatedAt: '2026-10-18T10:00:00Z' });

    // 冲突未处理时用户又编辑：状态必须留在 conflict，否则自动保存会立刻
    // 再撞一次 409，对话框无限弹。
    store.getState().dispatch(addChildCommand('a'));
    expect(store.getState().save.status).toBe('conflict');
  });

  it('loadDocument 清掉冲突状态', () => {
    const { store } = makeStore();
    store.getState().markConflict(7, null);
    store.getState().loadDocument(docWithTree());
    expect(store.getState().save).toEqual({ status: 'idle', at: null, error: null, conflict: null });
  });

  it('构造时可带服务器版本号', () => {
    const store = createEditorStore({ doc: docWithTree(), version: 5 });
    expect(store.getState().version).toBe(5);
  });
});
