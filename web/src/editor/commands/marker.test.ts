import { describe, expect, it } from 'vitest';
import { createEditorStore } from '../store/editor-store';
import { docWithTree } from '../test-utils';
import { findTopic } from '../model/traverse';
import { clearMarkersCommand, toggleMarkerCommand } from './marker';

describe('主题标记命令', () => {
  const makeStore = () => createEditorStore({ doc: docWithTree() });
  it('同组替换、异组共存、再次点击取消，支持撤销重做', () => {
    const store = makeStore();
    const markers = () => findTopic(store.getState().doc, 'a')!.topic.markers.map((item) => item.markerId);
    store.getState().dispatch(toggleMarkerCommand(['a'], 'priority-1'));
    store.getState().dispatch(toggleMarkerCommand(['a'], 'flag-red'));
    store.getState().dispatch(toggleMarkerCommand(['a'], 'priority-2'));
    expect(markers()).toEqual(['flag-red', 'priority-2']);
    store.getState().dispatch(toggleMarkerCommand(['a'], 'priority-2'));
    expect(markers()).toEqual(['flag-red']);
    store.getState().undo(); expect(markers()).toContain('priority-2');
    store.getState().redo(); expect(markers()).toEqual(['flag-red']);
  });
  it('混合选区统一应用，全部相同时统一取消；去重且一条历史', () => {
    const store = makeStore();
    store.getState().dispatch(toggleMarkerCommand(['a'], 'priority-1'));
    const before = store.getState().past.length;
    store.getState().dispatch(toggleMarkerCommand(['a', 'b', 'b', 'missing'], 'priority-1'));
    const a = () => findTopic(store.getState().doc, 'a')!.topic.markers;
    const b = () => findTopic(store.getState().doc, 'b')!.topic.markers;
    expect(a()).toEqual(b()); expect(a()).toHaveLength(1);
    expect(store.getState().past).toHaveLength(before + 1);
    store.getState().dispatch(toggleMarkerCommand(['a', 'b'], 'priority-1'));
    expect(a()).toEqual([]); expect(b()).toEqual([]);
    store.getState().undo(); expect(a()).toHaveLength(1); expect(b()).toHaveLength(1);
  });
  it('空选区、未知标记和重复清空不会创建历史', () => {
    const store = makeStore(); const before = store.getState().doc;
    store.getState().dispatch(toggleMarkerCommand([], 'priority-1'));
    store.getState().dispatch(toggleMarkerCommand(['a'], 'unknown'));
    store.getState().dispatch(clearMarkersCommand(['a']));
    expect(store.getState().doc).toBe(before);
    store.getState().dispatch(toggleMarkerCommand(['a'], 'task-done'));
    store.getState().dispatch(clearMarkersCommand(['a', 'a']));
    expect(findTopic(store.getState().doc, 'a')!.topic.markers).toEqual([]);
    store.getState().undo(); expect(findTopic(store.getState().doc, 'a')!.topic.markers[0]!.markerId).toBe('task-done');
  });
});
