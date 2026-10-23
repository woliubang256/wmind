import { describe, expect, it } from 'vitest';
import { createEditorStore } from '../store/editor-store';
import { deterministicIds, docWithTree } from '../test-utils';
import { collectBoundaries, collectSummaries, findTopic } from '../model/traverse';
import {
  addBoundaryCommand,
  addRelationshipCommand,
  addSummaryCommand,
  annotationTitle,
  removeAnnotationCommand,
  renameAnnotationCommand,
  summaryTarget,
  updateRelationshipStyleCommand,
} from './annotation';

function makeStore() {
  return createEditorStore({
    doc: docWithTree(),
    now: () => 1_000,
    nextId: deterministicIds('new'),
  });
}

const sheetOf = (store: ReturnType<typeof makeStore>) => store.getState().doc.sheets[0]!;

describe('addSummaryCommand', () => {
  it('跨父级选择完整保留，以最近共同祖先挂载', () => {
    const store = makeStore();
    const target = summaryTarget(sheetOf(store), ['a1', 'b1']);
    expect(target).toEqual({ topicId: 'root', range: ['a1', 'b1'] });
    store.getState().dispatch(addSummaryCommand({ ...target!, title: '跨分支' }));
    expect(collectSummaries(sheetOf(store))[0]!.range).toEqual(['a1', 'b1']);
    store.getState().undo();
    expect(collectSummaries(sheetOf(store))).toHaveLength(0);
    store.getState().redo();
    expect(collectSummaries(sheetOf(store))[0]!.range).toEqual(['a1', 'b1']);
  });

  it('同级取父主题，跨自由主题保留选区，空选区没有目标', () => {
    const sheet = sheetOf(makeStore());
    expect(summaryTarget(sheet, ['a1', 'a2'])).toEqual({ topicId: 'a', range: ['a1', 'a2'] });
    expect(summaryTarget(sheet, ['a1', 'f1x', 'a1'])).toEqual({ topicId: 'root', range: ['a1', 'f1x'] });
    expect(summaryTarget(sheet, [])).toBeNull();
  });

  it('相同范围换序或含重复 id 反复新增时，只有一条概要和一次历史', () => {
    const store = makeStore();
    store.getState().dispatch(addSummaryCommand({ topicId: 'a', range: ['a1', 'a2'], title: '保留标题' }));
    const before = store.getState().doc;
    store.getState().dispatch(addSummaryCommand({ topicId: 'a', range: ['a2', 'a1', 'a2'], title: '重复' }));
    expect(store.getState().doc).toBe(before);
    expect(store.getState().past).toHaveLength(1);
    expect(collectSummaries(sheetOf(store))).toHaveLength(1);
  });

  it('概要落在画布级与父主题两处，读取侧去重后只有一条', () => {
    const store = makeStore();
    store.getState().dispatch(addSummaryCommand({ topicId: 'a', range: ['a1', 'a2'], title: '概要' }));

    const sheet = sheetOf(store);
    expect(sheet.summaries).toHaveLength(1);
    // XMind 的存法：父主题上也有一份。
    expect(findTopic(store.getState().doc, 'a')!.topic.summaries).toHaveLength(1);
    // 合并读取时按 id 去重，不会画两条。
    expect(collectSummaries(sheet)).toHaveLength(1);
    expect(collectSummaries(sheet)[0]!.range).toEqual(['a1', 'a2']);
  });

  it('范围里的无效 id 被滤掉；全无效时什么都不做', () => {
    const store = makeStore();
    store.getState().dispatch(addSummaryCommand({ topicId: 'a', range: ['a1', 'ghost'], title: 'S' }));
    expect(collectSummaries(sheetOf(store))[0]!.range).toEqual(['a1']);

    const before = store.getState().doc;
    store.getState().dispatch(addSummaryCommand({ topicId: 'a', range: ['ghost'], title: 'S' }));
    expect(store.getState().doc).toBe(before);
  });

  it('父主题不存在时拒绝', () => {
    const store = makeStore();
    const before = store.getState().doc;
    store.getState().dispatch(addSummaryCommand({ topicId: 'ghost', range: ['a1'], title: 'S' }));
    expect(store.getState().doc).toBe(before);
  });
});

describe('addBoundaryCommand', () => {
  it('写入画布级并被读取侧收进来', () => {
    const store = makeStore();
    store.getState().dispatch(addBoundaryCommand({ range: ['a', 'b'] }));
    expect(collectBoundaries(sheetOf(store))).toHaveLength(1);
    expect(collectBoundaries(sheetOf(store))[0]!.title).toBe('');
  });

  it('空范围不产生历史', () => {
    const store = makeStore();
    store.getState().dispatch(addBoundaryCommand({ range: [] }));
    expect(store.getState().past).toHaveLength(0);
  });
});

describe('addRelationshipCommand', () => {
  it('两端不同且都存在时建立联系', () => {
    const store = makeStore();
    store.getState().dispatch(addRelationshipCommand({ fromId: 'a1', toId: 'b1' }));
    const list = sheetOf(store).relationships;
    expect(list).toHaveLength(1);
    expect([list[0]!.end1Id, list[0]!.end2Id]).toEqual(['a1', 'b1']);
  });

  it('同一端 / 不存在的端一律拒绝', () => {
    const store = makeStore();
    store.getState().dispatch(addRelationshipCommand({ fromId: 'a1', toId: 'a1' }));
    store.getState().dispatch(addRelationshipCommand({ fromId: 'a1', toId: 'ghost' }));
    expect(sheetOf(store).relationships).toHaveLength(0);
  });
});

describe('renameAnnotationCommand', () => {
  it('联系可以清空标题，仍能通过线条重新编辑', () => {
    const store = makeStore();
    store.getState().dispatch(addRelationshipCommand({ fromId: 'a1', toId: 'b1', title: '旧' }));
    const id = sheetOf(store).relationships[0]!.id;
    store.getState().dispatch(renameAnnotationCommand('relationship', id, ''));
    expect(sheetOf(store).relationships[0]!.title).toBe('');
  });
  it('概要两处都改名，读取侧不会看到旧标题', () => {
    const store = makeStore();
    store.getState().dispatch(addSummaryCommand({ topicId: 'a', range: ['a1'], title: '旧' }));
    const id = collectSummaries(sheetOf(store))[0]!.id;

    store.getState().dispatch(renameAnnotationCommand('summary', id, '新'));
    expect(annotationTitle(sheetOf(store), 'summary', id)).toBe('新');
    expect(findTopic(store.getState().doc, 'a')!.topic.summaries[0]!.title).toBe('新');
  });

  it('连续改名合并成一条历史', () => {
    const store = makeStore();
    store.getState().dispatch(addBoundaryCommand({ range: ['a'] }));
    const id = collectBoundaries(sheetOf(store))[0]!.id;
    const before = store.getState().past.length;

    store.getState().dispatch(renameAnnotationCommand('boundary', id, '一'));
    store.getState().dispatch(renameAnnotationCommand('boundary', id, '一二'));
    expect(store.getState().past.length).toBe(before + 1);
    expect(annotationTitle(sheetOf(store), 'boundary', id)).toBe('一二');
  });

  it('空标题被忽略（画布上会变成一块点不中的空白）', () => {
    const store = makeStore();
    store.getState().dispatch(addBoundaryCommand({ range: ['a'], title: '保留' }));
    const id = collectBoundaries(sheetOf(store))[0]!.id;
    store.getState().dispatch(renameAnnotationCommand('boundary', id, '   '));
    expect(annotationTitle(sheetOf(store), 'boundary', id)).toBe('保留');
  });
});

describe('updateRelationshipStyleCommand', () => {
  it('只改联系样式并可撤销重做，端点身份不变', () => {
    const store = makeStore();
    store.getState().dispatch(addRelationshipCommand({ fromId: 'a1', toId: 'b1' }));
    const id = sheetOf(store).relationships[0]!.id;
    const patch = { lineColor: '#E32925', lineWidth: 4, lineStart: 'arrow', lineEnd: 'arrow', lineStyle: 'elbow', borderStyle: 'solid' } as const;
    const topicStyle = findTopic(store.getState().doc, 'a1')!.topic.style;
    store.getState().dispatch(updateRelationshipStyleCommand(id, patch));
    expect(sheetOf(store).relationships[0]!.style).toEqual(patch);
    expect(findTopic(store.getState().doc, 'a1')!.topic.style).toBe(topicStyle);
    store.getState().undo();
    expect(sheetOf(store).relationships[0]!.style).toBeNull();
    store.getState().redo();
    expect(sheetOf(store).relationships[0]).toMatchObject({ end1Id: 'a1', end2Id: 'b1', style: patch });
  });

  it('重复补丁不产生历史，undefined 恢复继承', () => {
    const store = makeStore();
    store.getState().dispatch(addRelationshipCommand({ fromId: 'a1', toId: 'b1' }));
    const id = sheetOf(store).relationships[0]!.id;
    store.getState().dispatch(updateRelationshipStyleCommand(id, { lineWidth: 4 }));
    const before = store.getState().doc;
    store.getState().dispatch(updateRelationshipStyleCommand(id, { lineWidth: 4 }));
    expect(store.getState().doc).toBe(before);
    store.getState().dispatch(updateRelationshipStyleCommand(id, { lineWidth: undefined }));
    expect(sheetOf(store).relationships[0]!.style).toEqual({});
  });
});

describe('removeAnnotationCommand', () => {
  it('概要两个落点一起删，不留孤儿', () => {
    const store = makeStore();
    store.getState().dispatch(addSummaryCommand({ topicId: 'a', range: ['a1'], title: 'S' }));
    const id = collectSummaries(sheetOf(store))[0]!.id;

    store.getState().dispatch(removeAnnotationCommand('summary', id));
    expect(sheetOf(store).summaries).toHaveLength(0);
    expect(findTopic(store.getState().doc, 'a')!.topic.summaries).toHaveLength(0);
    expect(collectSummaries(sheetOf(store))).toHaveLength(0);
  });

  it('删除不存在的 id 是空操作', () => {
    const store = makeStore();
    const before = store.getState().doc;
    store.getState().dispatch(removeAnnotationCommand('relationship', 'ghost'));
    expect(store.getState().doc).toBe(before);
  });

  it('可撤销', () => {
    const store = makeStore();
    store.getState().dispatch(addBoundaryCommand({ range: ['a'] }));
    const id = collectBoundaries(sheetOf(store))[0]!.id;
    store.getState().dispatch(removeAnnotationCommand('boundary', id));
    expect(collectBoundaries(sheetOf(store))).toHaveLength(0);
    store.getState().undo();
    expect(collectBoundaries(sheetOf(store))).toHaveLength(1);
  });
});
