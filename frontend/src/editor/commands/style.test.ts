import { describe, expect, it } from 'vitest';
import { changeTopicShapeCommand, nextFillColor, resetStyleCommand, updateStyleCommand } from './style';
import { createSheet, defaultTheme } from '../model/create';
import { layoutMindmap } from '../layout/mindmap';
import { parseDocument } from '../model/validate';
import { addChildCommand, addSiblingCommand } from './topic';
import { createEditorStore } from '../store/editor-store';
import { findTopic } from '../model/traverse';
import { docWithTree } from '../test-utils';

const theme = defaultTheme();

describe('changeTopicShapeCommand', () => {
  it('只统一当前画布的主题形状，保留其他样式和原有节点形状字段', () => {
    const doc = docWithTree();
    doc.sheets.push(createSheet({ id: 'other' }));
    doc.sheets[0]!.rootTopic.style = { shape: 'diamond', fill: '#456A86', fontSize: 32 };
    const store = createEditorStore({ doc });
    store.getState().select(['a']);
    store.getState().dispatch(changeTopicShapeCommand('ellipse'));
    const next = store.getState().doc;
    expect(next.sheets[0]!.topicShape).toBe('ellipse');
    expect(next.sheets[1]!.topicShape).toBeUndefined();
    expect(next.sheets[0]!.rootTopic.style).toEqual(doc.sheets[0]!.rootTopic.style);
    const layout = layoutMindmap({ sheet: next.sheets[0]!, theme: next.theme });
    expect([...layout.styles.values()].every((style) => style.shape === 'ellipse')).toBe(true);
    expect(layout.styles.get('root')).toMatchObject({ fill: '#456A86', fontSize: 32 });
    expect(store.getState().selection).toEqual(['a']);
  });

  it('新增子主题、同级主题、自由主题同级以及折叠后代继承画布形状', () => {
    const store = createEditorStore({ doc: docWithTree() });
    store.getState().dispatch(changeTopicShapeCommand('hexagon'));
    store.getState().dispatch(addChildCommand('a2', '新子主题'));
    store.getState().dispatch(addSiblingCommand('a', '新同级'));
    store.getState().dispatch(addSiblingCommand('f1', '新自由主题'));
    const { doc } = store.getState();
    const layout = layoutMindmap({ sheet: doc.sheets[0]!, theme: doc.theme });
    expect(layout.styles.get('a2x')?.shape).toBe('hexagon');
    expect([...layout.styles.values()].every((style) => style.shape === 'hexagon')).toBe(true);
  });

  it('一次撤销和重做恢复整张画布，重复应用不增加历史', () => {
    const store = createEditorStore({ doc: docWithTree() });
    store.getState().dispatch(changeTopicShapeCommand('capsule'));
    const revision = store.getState().revision;
    store.getState().dispatch(changeTopicShapeCommand('capsule'));
    expect(store.getState().revision).toBe(revision);
    store.getState().undo();
    expect(store.getState().doc.sheets[0]!.topicShape).toBeUndefined();
    store.getState().redo();
    expect(store.getState().doc.sheets[0]!.topicShape).toBe('capsule');
  });

  it('回到跟随主题时恢复旧形状，清除后重复操作也是空操作', () => {
    const doc = docWithTree();
    doc.sheets[0]!.rootTopic.style = { shape: 'diamond' };
    const store = createEditorStore({ doc });
    store.getState().dispatch(changeTopicShapeCommand('capsule'));
    store.getState().dispatch(changeTopicShapeCommand(undefined));
    const revision = store.getState().revision;
    store.getState().dispatch(changeTopicShapeCommand(undefined));
    expect(store.getState().revision).toBe(revision);
    const next = store.getState().doc;
    expect(layoutMindmap({ sheet: next.sheets[0]!, theme: next.theme }).styles.get('root')?.shape).toBe('diamond');
  });

  it('原生保存解析保留统一形状，旧文件不添加覆盖，非法值留警告', () => {
    const doc = docWithTree();
    const legacy = parseDocument(doc).document;
    expect(legacy.sheets[0]!.topicShape).toBeUndefined();
    doc.sheets[0]!.topicShape = 'circle';
    expect(parseDocument(JSON.parse(JSON.stringify(doc))).document.sheets[0]!.topicShape).toBe('circle');
    const raw = JSON.parse(JSON.stringify(doc));
    raw.sheets[0].topicShape = 'unknown';
    const result = parseDocument(raw);
    expect(result.document.sheets[0]!.topicShape).toBe('rounded-rect');
    expect(result.warnings.some((warning) => warning.includes('topicShape'))).toBe(true);
  });
});

describe('nextFillColor', () => {
  it('从调色板外的颜色（含根节点的白底）进入调色板首位', () => {
    expect(nextFillColor(theme, '#FFFFFF')).toBe(theme.palette.colors[0]);
    expect(nextFillColor(theme, null)).toBe(theme.palette.colors[0]);
  });

  it('按调色板顺序前进', () => {
    expect(nextFillColor(theme, theme.palette.colors[0])).toBe(theme.palette.colors[1]);
    expect(nextFillColor(theme, theme.palette.colors[1])).toBe(theme.palette.colors[2]);
  });

  it('大小写不影响命中', () => {
    const lower = theme.palette.colors[0]!.toLowerCase();
    expect(nextFillColor(theme, lower)).toBe(theme.palette.colors[1]);
  });

  it('走完最后一个回到继承（null），再按一次从头开始', () => {
    const last = theme.palette.colors[theme.palette.colors.length - 1]!;
    expect(nextFillColor(theme, last)).toBeNull();
    expect(nextFillColor(theme, null)).toBe(theme.palette.colors[0]);
  });

  it('整轮循环能回到起点', () => {
    let current: string | null = null;
    const seen: (string | null)[] = [];
    for (let i = 0; i <= theme.palette.colors.length; i += 1) {
      current = nextFillColor(theme, current);
      seen.push(current);
    }
    // 末尾的 null 是「回到继承」那一格，正好把整轮闭环。
    expect(seen).toEqual([...theme.palette.colors, null]);
  });

  it('没有调色板时返回 null，不抛', () => {
    const empty = { ...theme, palette: { ...theme.palette, colors: [] }, rainbowColors: [] };
    expect(nextFillColor(empty, '#123456')).toBeNull();
  });
});

describe('updateStyleCommand', () => {
  it('只写补丁里的字段，其余保持继承', () => {
    const store = createEditorStore({ doc: docWithTree() });
    store.getState().dispatch(updateStyleCommand(['a'], { fontWeight: 700 }));

    const style = findTopic(store.getState().doc, 'a')!.topic.style;
    expect(style).toEqual({ fontWeight: 700 });
  });

  it('fill 置 null 表示无填充（不是继承）', () => {
    const store = createEditorStore({ doc: docWithTree() });
    store.getState().dispatch(updateStyleCommand(['a'], { fill: '#E32925' }));
    store.getState().dispatch(updateStyleCommand(['a'], { fill: null }));

    expect(findTopic(store.getState().doc, 'a')!.topic.style!.fill).toBeNull();
  });

  it('传 undefined 把字段删掉，回到继承', () => {
    const store = createEditorStore({ doc: docWithTree() });
    store.getState().dispatch(updateStyleCommand(['a'], { fill: '#E32925', fontWeight: 700 }));
    store.getState().dispatch(updateStyleCommand(['a'], { fill: undefined }));

    const style = findTopic(store.getState().doc, 'a')!.topic.style!;
    expect('fill' in style).toBe(false);
    expect(style.fontWeight).toBe(700);
  });

  it('已经是继承态时再传 undefined 是空操作', () => {
    const store = createEditorStore({ doc: docWithTree() });
    const revision = store.getState().revision;
    store.getState().dispatch(updateStyleCommand(['a'], { fill: undefined }));
    expect(store.getState().revision).toBe(revision);
  });

  it('批量作用于多个节点，不存在的 id 静默跳过', () => {
    const store = createEditorStore({ doc: docWithTree() });
    store.getState().dispatch(updateStyleCommand(['a', 'b', 'nope'], { fontWeight: 700 }));

    expect(findTopic(store.getState().doc, 'a')!.topic.style!.fontWeight).toBe(700);
    expect(findTopic(store.getState().doc, 'b')!.topic.style!.fontWeight).toBe(700);
  });

  it('同值再写一次是空操作，不进历史', () => {
    const store = createEditorStore({ doc: docWithTree() });
    store.getState().dispatch(updateStyleCommand(['a'], { fontWeight: 700 }));
    const revision = store.getState().revision;
    store.getState().dispatch(updateStyleCommand(['a'], { fontWeight: 700 }));
    expect(store.getState().revision).toBe(revision);
  });
});

describe('resetStyleCommand', () => {
  it('清空节点级样式但不动兄弟节点', () => {
    const store = createEditorStore({ doc: docWithTree() });
    store.getState().dispatch(updateStyleCommand(['a', 'b'], { fontWeight: 700 }));
    store.getState().dispatch(resetStyleCommand(['a']));

    expect(findTopic(store.getState().doc, 'a')!.topic.style).toEqual({});
    expect(findTopic(store.getState().doc, 'b')!.topic.style!.fontWeight).toBe(700);
  });
});
