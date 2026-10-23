import { describe, expect, it } from 'vitest';
import { createEditorStore } from '../store/editor-store';
import { docWithTree } from '../test-utils';
import { findTopicInSheet } from '../model/traverse';
import { parseDocument } from '../model/validate';
import { cloneTopic } from '../model/clone';
import { updateContentCommand } from './content';

describe('Insert 内容命令', () => {
  it('批量标签与待办只占一条历史，撤销重做完整恢复', () => {
    const store = createEditorStore({ doc: docWithTree() });
    store.getState().dispatch(updateContentCommand(['a', 'b'], { labels: [' 重点 ', '重点', ''], content: { todo: false } }));
    expect(store.getState().past).toHaveLength(1);
    expect(findTopicInSheet(store.getState().doc.sheets[0]!, 'b')!.topic).toMatchObject({ labels: ['重点'], content: { todo: false } });
    store.getState().undo();
    expect(findTopicInSheet(store.getState().doc.sheets[0]!, 'b')!.topic.content).toBeUndefined();
    store.getState().redo();
    expect(findTopicInSheet(store.getState().doc.sheets[0]!, 'b')!.topic.content?.todo).toBe(false);
  });
  it('修改一项不覆盖其他项，移除项目不留下空内容', () => {
    const store = createEditorStore({ doc: docWithTree() });
    store.getState().dispatch(updateContentCommand(['a'], { content: { todo: true, sticker: 'star' } }));
    store.getState().dispatch(updateContentCommand(['a'], { content: { sticker: undefined } }));
    expect(findTopicInSheet(store.getState().doc.sheets[0]!, 'a')!.topic.content).toEqual({ todo: true });
    store.getState().dispatch(updateContentCommand(['a'], { content: { todo: undefined } }));
    expect(findTopicInSheet(store.getState().doc.sheets[0]!, 'a')!.topic.content).toBeUndefined();
  });
  it('原生格式与复制保留新内容，复制后无共享引用', () => {
    const doc = docWithTree(); const topic = doc.sheets[0]!.rootTopic;
    topic.content = { todo: true, task: { progress: 50, priority: 2, assignee: '测试', start: '2026-10-23', due: '2026-10-24' },
      attachments: [{ id: 'file', name: 'file.txt', bytes: 3, data: 'YWJj', kind: 'file' }] };
    expect(parseDocument(JSON.parse(JSON.stringify(doc))).document.sheets[0]!.rootTopic.content).toEqual(topic.content);
    const copy = cloneTopic(topic, { nextId: () => 'copy' });
    expect(copy.content).toEqual(topic.content);
    expect(copy.content).not.toBe(topic.content);
  });
  it('拒绝危险链接和包含无效 id 的批量操作，不产生部分修改', () => {
    const store = createEditorStore({ doc: docWithTree() }); const before = store.getState().doc;
    expect(() => store.getState().dispatch(updateContentCommand(['a'], { href: 'javascript:alert(1)' }))).toThrow('invalid-link');
    store.getState().dispatch(updateContentCommand(['a', 'missing'], { labels: ['不能部分写'] }));
    expect(store.getState().doc).toBe(before);
  });
});
