import { describe, expect, it } from 'vitest';
import { changeTitleCommand } from './document';
import { createEditorStore } from '../store/editor-store';
import { docWithTree } from '../test-utils';
import { findTopic } from '../model/traverse';

describe('changeTitleCommand', () => {
  it('同时改文档标题与当前画布的根主题标题', () => {
    const store = createEditorStore({ doc: docWithTree() });
    store.getState().dispatch(changeTitleCommand('新标题'));

    const state = store.getState();
    expect(state.doc.title).toBe('新标题');
    expect(findTopic(state.doc, 'root')?.topic.title).toBe('新标题');
  });

  it('只产生一条撤销记录，撤销后两个字段一起回退', () => {
    const store = createEditorStore({ doc: docWithTree() });
    const before = store.getState().doc;

    store.getState().dispatch(changeTitleCommand('新标题'));
    expect(store.getState().past).toHaveLength(1);

    store.getState().undo();
    const state = store.getState();
    expect(state.doc.title).toBe(before.title);
    expect(findTopic(state.doc, 'root')?.topic.title).toBe('中心主题');
  });

  it('连续输入在合并窗口内只留一条历史', () => {
    let clock = 1_000;
    const store = createEditorStore({ doc: docWithTree(), now: () => clock });
    for (const title of ['产', '产品', '产品规']) {
      store.getState().dispatch(changeTitleCommand(title));
      clock += 100;
    }
    expect(store.getState().past).toHaveLength(1);
    expect(store.getState().doc.title).toBe('产品规');
  });
});
