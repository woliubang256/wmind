import { describe, expect, it } from 'vitest';
import { createEditorStore } from '../store/editor-store';
import { deterministicIds, docWithTree } from '../test-utils';
import { findTopic } from '../model/traverse';
import { detachTopicsCommand, moveTopicsCommand } from './topic';

function makeStore() {
  return createEditorStore({
    doc: docWithTree(),
    now: () => 1_000,
    nextId: deterministicIds('new'),
  });
}

const childIds = (store: ReturnType<typeof makeStore>, id: string): string[] =>
  findTopic(store.getState().doc, id)!.topic.children.attached.map((t) => t.id);

const floatingIds = (store: ReturnType<typeof makeStore>): string[] =>
  store.getState().doc.sheets[0]!.floatingTopics.map((t) => t.id);

describe('moveTopicsCommand', () => {
  it('批量移动只产生一条历史', () => {
    const store = makeStore();
    store.getState().dispatch(moveTopicsCommand(['a1', 'b1'], 'b'));

    // b1 本来就在 b 下面，先被摘掉再按传入顺序插回去，所以排在 a1 之后。
    expect(childIds(store, 'b')).toEqual(['a1', 'b1']);
    expect(store.getState().past).toHaveLength(1);
  });

  it('按给定下标插入，保持传入顺序', () => {
    const store = makeStore();
    // a 的子节点是 [a1, a2]，插到最前面。
    store.getState().dispatch(moveTopicsCommand(['b1'], 'a', 0));
    expect(childIds(store, 'a')).toEqual(['b1', 'a1', 'a2']);
  });

  it('下标越界时追加到末尾而不是报错', () => {
    const store = makeStore();
    store.getState().dispatch(moveTopicsCommand(['b1'], 'a', 99));
    expect(childIds(store, 'a')).toEqual(['a1', 'a2', 'b1']);
  });

  it('同时拖父节点与子节点时，子节点跟着父节点走，不会复制一份', () => {
    const store = makeStore();
    store.getState().dispatch(moveTopicsCommand(['a', 'a1'], 'b'));

    // a1 仍然只存在于 a 下面。
    expect(childIds(store, 'a')).toEqual(['a1', 'a2']);
    expect(childIds(store, 'b')).toEqual(['b1', 'a']);
    expect(childIds(store, 'root')).toEqual(['b']);
  });

  it('任一个被拖节点是目标的祖先时整批拒绝', () => {
    const store = makeStore();
    const before = store.getState().doc;
    store.getState().dispatch(moveTopicsCommand(['a1', 'a'], 'a1'));
    expect(store.getState().doc).toBe(before);
    expect(store.getState().past).toHaveLength(0);
  });

  it('包含根节点时整批拒绝（根不能移动）', () => {
    const store = makeStore();
    const before = store.getState().doc;
    store.getState().dispatch(moveTopicsCommand(['root', 'a1'], 'b'));
    expect(store.getState().doc).toBe(before);
  });

  it('自由主题不能作为父节点', () => {
    const store = makeStore();
    const before = store.getState().doc;
    store.getState().dispatch(moveTopicsCommand(['a1'], 'f1'));
    expect(store.getState().doc).toBe(before);
  });

  it('展开折叠的目标，否则移进去的内容看不见', () => {
    const store = makeStore();
    store.getState().dispatch(moveTopicsCommand(['b1'], 'a2'));
    expect(findTopic(store.getState().doc, 'a2')!.topic.collapsed).toBe(false);
  });
});

describe('detachTopicsCommand', () => {
  it('批量转为自由主题，只产生一条历史', () => {
    const store = makeStore();
    store.getState().dispatch(detachTopicsCommand(['a1', 'b1']));

    expect(floatingIds(store)).toEqual(['f1', 'a1', 'b1']);
    expect(childIds(store, 'a')).toEqual(['a2']);
    expect(store.getState().past).toHaveLength(1);
  });

  it('同时拖父节点与子节点时只搬父节点', () => {
    const store = makeStore();
    store.getState().dispatch(detachTopicsCommand(['a', 'a1']));

    expect(floatingIds(store)).toEqual(['f1', 'a']);
    expect(childIds(store, 'a')).toEqual(['a1', 'a2']);
  });

  it('根节点与已是自由主题的节点被跳过', () => {
    const store = makeStore();
    const before = store.getState().doc;
    store.getState().dispatch(detachTopicsCommand(['root', 'f1']));
    expect(store.getState().doc).toBe(before);
  });
});
