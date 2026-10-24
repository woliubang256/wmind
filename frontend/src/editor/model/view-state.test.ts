import { describe, expect, it } from 'vitest';
import { createDocument } from './create';
import { parseDocument } from './validate';
import { createEditorStore } from '../store/editor-store';
import { renameTopicCommand, toggleCollapseCommand } from '../commands/topic';
import { removeSheetCommand } from '../commands/sheet';
import type { DocumentViewState } from './types';

const view = { centerX: -120, centerY: 260, zoom: 1.5 };

describe('作者画布视图保存', () => {
  it('原生文档归一化保留当前画布和世界坐标视图', () => {
    const doc = createDocument();
    const id = doc.sheets[0]!.id;
    const viewState = { activeSheetId: id, sheets: { [id]: view } };
    const parsed = parseDocument({ ...doc, viewState }).document;
    expect(parsed).toHaveProperty('viewState', viewState);
  });

  it('编辑器重开时使用保存的当前画布', () => {
    const doc = createDocument();
    doc.sheets.push({ ...doc.sheets[0]!, id: 'second' });
    const parsed = parseDocument({ ...doc, viewState: { activeSheetId: 'second', sheets: {} } }).document;
    expect(createEditorStore({ doc: parsed }).getState().sheetId).toBe('second');
  });

  it('折叠在保存归一化及重开后保留', () => {
    const doc = createDocument();
    const root = doc.sheets[0]!.rootTopic;
    root.children.attached.push({ ...root, id: 'child', children: { attached: [], detached: [] } });
    const store = createEditorStore({ doc });
    store.getState().dispatch(toggleCollapseCommand(root.id));
    const saved = parseDocument(JSON.parse(JSON.stringify(store.getState().doc))).document;
    expect(saved.sheets[0]!.rootTopic.collapsed).toBe(true);
    expect(store.getState().past).toHaveLength(1);
  });

  it('视图保存不占撤销，撤销编辑不回滚视图', () => {
    const doc = createDocument();
    const id = doc.sheets[0]!.id;
    const store = createEditorStore({ doc });
    store.getState().dispatch(renameTopicCommand(doc.sheets[0]!.rootTopic.id, '修改'));
    // 新动作既会进入自动保存，也不会清空已有重做历史。
    expect(store.getState()).toHaveProperty('saveCanvasView');
    store.getState().saveCanvasView(id, view);
    expect(store.getState().past).toHaveLength(1);
    store.getState().undo();
    expect(store.getState().doc).toHaveProperty(`viewState.sheets.${id}`, view);
    expect(store.getState().future).toHaveLength(1);
    store.getState().redo();
    expect(store.getState().doc).toHaveProperty(`viewState.sheets.${id}`, view);
  });

  it('内容重载提供独立代次以重置同画布的旧视角缓存', () => {
    const doc = createDocument();
    const store = createEditorStore({ doc });
    expect(store.getState()).toHaveProperty('documentLoadGeneration', 0);
    store.getState().loadDocument(doc);
    expect(store.getState()).toHaveProperty('documentLoadGeneration', 1);
  });

  it.each([
    ['非数值缩放', { ...view, zoom: 'bad' }],
    ['零缩放', { ...view, zoom: 0 }],
    ['越界缩放', { ...view, zoom: 5 }],
    ['非有限中心', { ...view, centerX: Infinity }],
    ['越界中心', { ...view, centerY: 1e12 }],
  ])('远端重载丢弃%s，不能绕过首屏视图守卫', (_name, badView) => {
    const doc = createDocument();
    const id = doc.sheets[0]!.id;
    const store = createEditorStore({ doc });
    store.getState().saveCanvasView(id, view);
    // reload 的服务端响应可能未经 parseDocument；坏视图必须在装入 store 时归一。
    store.getState().loadDocument({
      ...doc,
      viewState: { activeSheetId: id, sheets: { [id]: badView } } as unknown as DocumentViewState,
    });
    expect(store.getState().doc.viewState).toEqual({ activeSheetId: id, sheets: {} });
    expect(store.getState().sheetId).toBe(id);
  });

  it('远端重载同步清理不存在画布的活动状态与视角，保留有效画布视角', () => {
    const doc = createDocument();
    const id = doc.sheets[0]!.id;
    const store = createEditorStore({ doc });
    store.getState().loadDocument({
      ...doc,
      viewState: { activeSheetId: 'removed', sheets: { removed: view, [id]: view } },
    });
    expect(store.getState().sheetId).toBe(id);
    expect(store.getState().doc.viewState).toEqual({ activeSheetId: id, sheets: { [id]: view } });
  });

  it('丢弃失效画布及坏数值，旧文件不补视图', () => {
    const doc = createDocument();
    const id = doc.sheets[0]!.id;
    expect(parseDocument(doc).document).not.toHaveProperty('viewState');
    for (const bad of [{ ...view, zoom: 0 }, { ...view, zoom: 5 }, { ...view, centerX: Infinity }, { ...view, centerY: 1e12 }, { ...view, zoom: '1' }]) {
      expect(parseDocument({ ...doc, viewState: { activeSheetId: 'missing', sheets: { [id]: bad, missing: view } } }).document)
        .toHaveProperty('viewState', { activeSheetId: id, sheets: {} });
    }
  });

  it('浏览、选区和重复视图不产生新保存，导航保留重做栈', () => {
    const doc = createDocument();
    const id = doc.sheets[0]!.id;
    const store = createEditorStore({ doc });
    store.getState().select([doc.sheets[0]!.rootTopic.id]);
    expect(store.getState().revision).toBe(0);
    store.getState().dispatch(renameTopicCommand(doc.sheets[0]!.rootTopic.id, '修改'));
    store.getState().undo();
    store.getState().saveCanvasView(id, view);
    const revision = store.getState().revision;
    store.getState().saveCanvasView(id, { ...view });
    expect(store.getState().revision).toBe(revision);
    expect(store.getState().past).toHaveLength(0);
    expect(store.getState().future).toHaveLength(1);
  });

  it('删除画布反复撤销重做后仍恢复其独立视角', () => {
    const doc = createDocument();
    const id = doc.sheets[0]!.id;
    doc.sheets.push({ ...doc.sheets[0]!, id: 'second' });
    doc.viewState = { activeSheetId: id, sheets: { [id]: view, second: { ...view, zoom: 0.75 } } };
    const store = createEditorStore({ doc });
    store.getState().dispatch(removeSheetCommand(id));
    store.getState().setSheet('second');
    store.getState().undo();
    expect(store.getState().doc.viewState?.sheets[id]).toEqual(view);
    store.getState().redo();
    store.getState().undo();
    expect(store.getState().doc.viewState?.sheets[id]).toEqual(view);
  });
});
