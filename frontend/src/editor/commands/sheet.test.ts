import { describe, expect, it } from 'vitest';
import {
  addSheetCommand,
  moveSheetCommand,
  removeSheetCommand,
  renameSheetCommand,
  sheetHasContent,
} from './sheet';
import { changeTitleCommand } from './document';
import { createEditorStore } from '../store/editor-store';
import { createSheet } from '../model/create';
import { docWithTree, topic } from '../test-utils';
import type { WmindDocument } from '../model/types';

/** 两张画布：第一张是 `docWithTree` 那棵树，第二张是空画布。 */
function docWithTwoSheets(): WmindDocument {
  const doc = docWithTree();
  doc.sheets.push({
    ...createSheet({ id: 'sh-2', title: '画布 2' }),
    rootTopic: topic('root2', '第二张中心主题'),
  });
  return doc;
}

describe('addSheetCommand', () => {
  it('追加到末尾，中心主题用默认文案而不是画布名', () => {
    const store = createEditorStore({ doc: docWithTree() });
    store.getState().dispatch(addSheetCommand({ id: 'sh-new', title: '画布 2' }));

    const sheets = store.getState().doc.sheets;
    expect(sheets).toHaveLength(2);
    expect(sheets[1]?.id).toBe('sh-new');
    expect(sheets[1]?.title).toBe('画布 2');
    // 画布名是导航标签，中心主题是内容——两者不联动，否则「重命名画布」
    // 看起来像改了图里的字。
    expect(sheets[1]?.rootTopic.title).toBe('中心主题');
  });

  it('沿用传入的结构', () => {
    const store = createEditorStore({ doc: docWithTree() });
    store.getState().dispatch(addSheetCommand({ id: 'sh-new', title: '画布 2', structure: 'brace' }));
    expect(store.getState().doc.sheets[1]?.structure).toBe('brace');
  });

  it('只产生一条历史，撤销后新画布消失', () => {
    const store = createEditorStore({ doc: docWithTree() });
    store.getState().dispatch(addSheetCommand({ id: 'sh-new', title: '画布 2' }));
    expect(store.getState().past).toHaveLength(1);

    store.getState().undo();
    expect(store.getState().doc.sheets).toHaveLength(1);
  });
});

describe('renameSheetCommand', () => {
  it('去掉首尾空白后写入', () => {
    const store = createEditorStore({ doc: docWithTwoSheets() });
    store.getState().dispatch(renameSheetCommand('sh-2', '  技术方案  '));
    expect(store.getState().doc.sheets[1]?.title).toBe('技术方案');
  });

  it('空白名不生效，也不产生历史', () => {
    const store = createEditorStore({ doc: docWithTwoSheets() });
    const before = store.getState().doc;
    store.getState().dispatch(renameSheetCommand('sh-2', '   '));

    expect(store.getState().doc).toBe(before);
    expect(store.getState().past).toHaveLength(0);
  });

  it('同名不产生历史', () => {
    const store = createEditorStore({ doc: docWithTwoSheets() });
    store.getState().dispatch(renameSheetCommand('sh-2', '画布 2'));
    expect(store.getState().past).toHaveLength(0);
  });

  it('不存在的画布静默忽略', () => {
    const store = createEditorStore({ doc: docWithTwoSheets() });
    const before = store.getState().doc;
    store.getState().dispatch(renameSheetCommand('nope', '新名字'));
    expect(store.getState().doc).toBe(before);
  });

  it('连续改名在合并窗口内只留一条历史', () => {
    let clock = 1_000;
    const store = createEditorStore({ doc: docWithTwoSheets(), now: () => clock });
    for (const title of ['技', '技术', '技术方案']) {
      store.getState().dispatch(renameSheetCommand('sh-2', title));
      clock += 100;
    }
    expect(store.getState().past).toHaveLength(1);
    expect(store.getState().doc.sheets[1]?.title).toBe('技术方案');
  });

  it('只改画布名，不碰中心主题与文档标题', () => {
    const store = createEditorStore({ doc: docWithTwoSheets() });
    store.getState().dispatch(renameSheetCommand('sh-1', '封面'));

    const state = store.getState();
    expect(state.doc.sheets[0]?.title).toBe('封面');
    expect(state.doc.sheets[0]?.rootTopic.title).toBe('中心主题');
    expect(state.doc.title).toBe('测试导图');
  });
});

describe('removeSheetCommand', () => {
  it('删掉指定画布，撤销后回到原来的位置', () => {
    const store = createEditorStore({ doc: docWithTwoSheets() });
    store.getState().dispatch(removeSheetCommand('sh-1'));

    expect(store.getState().doc.sheets.map((s) => s.id)).toEqual(['sh-2']);

    store.getState().undo();
    // 位置也要还原：插回末尾会让「删掉第一张再撤销」变成「顺序也变了」。
    expect(store.getState().doc.sheets.map((s) => s.id)).toEqual(['sh-1', 'sh-2']);
  });

  it('只剩一张时拒绝删除，且不产生历史', () => {
    const store = createEditorStore({ doc: docWithTree() });
    const before = store.getState().doc;
    store.getState().dispatch(removeSheetCommand('sh-1'));

    expect(store.getState().doc).toBe(before);
    expect(store.getState().past).toHaveLength(0);
  });

  it('三张里删中间一张，其余顺序不变', () => {
    const doc = docWithTwoSheets();
    doc.sheets.push({ ...createSheet({ id: 'sh-3', title: '画布 3' }) });
    const store = createEditorStore({ doc });

    store.getState().dispatch(removeSheetCommand('sh-2'));
    expect(store.getState().doc.sheets.map((s) => s.id)).toEqual(['sh-1', 'sh-3']);
  });
});

describe('moveSheetCommand', () => {
  it('往后挪一位', () => {
    const store = createEditorStore({ doc: docWithTwoSheets() });
    store.getState().dispatch(moveSheetCommand('sh-1', 1));
    expect(store.getState().doc.sheets.map((s) => s.id)).toEqual(['sh-2', 'sh-1']);
  });

  it('往前挪一位', () => {
    const store = createEditorStore({ doc: docWithTwoSheets() });
    store.getState().dispatch(moveSheetCommand('sh-2', 0));
    expect(store.getState().doc.sheets.map((s) => s.id)).toEqual(['sh-2', 'sh-1']);
  });

  it('越界下标夹到合法区间', () => {
    const store = createEditorStore({ doc: docWithTwoSheets() });
    store.getState().dispatch(moveSheetCommand('sh-1', 99));
    expect(store.getState().doc.sheets.map((s) => s.id)).toEqual(['sh-2', 'sh-1']);

    store.getState().dispatch(moveSheetCommand('sh-1', -5));
    expect(store.getState().doc.sheets.map((s) => s.id)).toEqual(['sh-1', 'sh-2']);
  });

  it('原地不动时不产生历史', () => {
    const store = createEditorStore({ doc: docWithTwoSheets() });
    store.getState().dispatch(moveSheetCommand('sh-1', 0));
    expect(store.getState().past).toHaveLength(0);
  });
});

describe('sheetHasContent', () => {
  it('只有中心主题的空画布返回 false', () => {
    expect(sheetHasContent(createSheet({ id: 'x' }))).toBe(false);
  });

  it('有子主题返回 true', () => {
    expect(sheetHasContent(docWithTree().sheets[0]!)).toBe(true);
  });

  it('只有自由主题也算有内容', () => {
    const sheet = createSheet({ id: 'x' });
    sheet.floatingTopics = [topic('f', '自由主题')];
    expect(sheetHasContent(sheet)).toBe(true);
  });

  it('只有关系线也算有内容', () => {
    const sheet = createSheet({ id: 'x' });
    sheet.relationships = [{ id: 'r', end1Id: 'a', end2Id: 'b', title: '', style: null }];
    expect(sheetHasContent(sheet)).toBe(true);
  });
});

describe('changeTitleCommand 与多画布', () => {
  it('改的是第一张画布的中心主题，即使当前停在第二张', () => {
    const store = createEditorStore({ doc: docWithTwoSheets(), sheetId: 'sh-2' });
    store.getState().dispatch(changeTitleCommand('新图名'));

    const sheets = store.getState().doc.sheets;
    expect(store.getState().doc.title).toBe('新图名');
    expect(sheets[0]?.rootTopic.title).toBe('新图名');
    expect(sheets[1]?.rootTopic.title).toBe('第二张中心主题');
  });
});

describe('store.setSheet', () => {
  it('切换后清空选中与编辑态', () => {
    const store = createEditorStore({ doc: docWithTwoSheets() });
    store.getState().select(['a', 'b']);
    store.getState().setEditing('a1');

    store.getState().setSheet('sh-2');

    const state = store.getState();
    expect(state.sheetId).toBe('sh-2');
    expect(state.selection).toEqual([]);
    expect(state.editingId).toBeNull();
  });

  it('不算文档变更：不标脏、不产生历史', () => {
    const store = createEditorStore({ doc: docWithTwoSheets() });
    const revision = store.getState().revision;

    store.getState().setSheet('sh-2');

    expect(store.getState().revision).toBe(revision);
    expect(store.getState().past).toHaveLength(0);
    expect(store.getState().save.status).toBe('idle');
  });

  it('切到同一张画布是空操作', () => {
    const store = createEditorStore({ doc: docWithTwoSheets() });
    store.getState().select(['a']);
    store.getState().setSheet('sh-1');
    // 同一张不该把选中清掉——用户点了一下已激活的标签，不该丢选中。
    expect(store.getState().selection).toEqual(['a']);
  });

  it('不存在的画布 id 被忽略，不会让界面落到空白画布上', () => {
    const store = createEditorStore({ doc: docWithTwoSheets() });
    store.getState().setSheet('ghost');
    expect(store.getState().sheetId).toBe('sh-1');
  });

  it('撤销会回到编辑发生时的那张画布', () => {
    const store = createEditorStore({ doc: docWithTwoSheets() });
    store.getState().dispatch(renameSheetCommand('sh-1', '封面'));
    store.getState().setSheet('sh-2');

    store.getState().undo();
    expect(store.getState().sheetId).toBe('sh-1');
    expect(store.getState().doc.sheets[0]?.title).toBe('画布 1');
  });
});
