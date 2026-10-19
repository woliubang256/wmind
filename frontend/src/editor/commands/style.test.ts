import { describe, expect, it } from 'vitest';
import { nextFillColor, resetStyleCommand, updateStyleCommand } from './style';
import { defaultTheme } from '../model/create';
import { createEditorStore } from '../store/editor-store';
import { findTopic } from '../model/traverse';
import { docWithTree } from '../test-utils';

const theme = defaultTheme();

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
