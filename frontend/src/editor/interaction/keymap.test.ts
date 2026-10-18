import { describe, expect, it } from 'vitest';
import { resolveKey } from './keymap';

describe('resolveKey', () => {
  it('无修饰键的基础键位', () => {
    expect(resolveKey({ key: 'Tab' })).toBe('topic.add-child');
    expect(resolveKey({ key: 'Enter' })).toBe('topic.add-sibling');
    expect(resolveKey({ key: 'F2' })).toBe('topic.edit');
    expect(resolveKey({ key: 'Escape' })).toBe('select.clear');
    expect(resolveKey({ key: 'Delete' })).toBe('topic.delete');
    expect(resolveKey({ key: 'Backspace' })).toBe('topic.delete');
  });

  it('方向键是几何邻接', () => {
    expect(resolveKey({ key: 'ArrowLeft' })).toBe('nav.left');
    expect(resolveKey({ key: 'ArrowRight' })).toBe('nav.right');
    expect(resolveKey({ key: 'ArrowUp' })).toBe('nav.up');
    expect(resolveKey({ key: 'ArrowDown' })).toBe('nav.down');
  });

  it('Ctrl / ⌘ + 方向键是结构跳转', () => {
    expect(resolveKey({ key: 'ArrowLeft', ctrlKey: true })).toBe('nav.parent');
    expect(resolveKey({ key: 'ArrowRight', ctrlKey: true })).toBe('nav.child');
    expect(resolveKey({ key: 'ArrowUp', ctrlKey: true })).toBe('nav.prev-sibling');
    expect(resolveKey({ key: 'ArrowDown', ctrlKey: true })).toBe('nav.next-sibling');
  });

  it('macOS 的 ⌘ 与 Ctrl 等价', () => {
    expect(resolveKey({ key: 'ArrowLeft', metaKey: true })).toBe('nav.parent');
    expect(resolveKey({ key: 'z', metaKey: true })).toBe('history.undo');
    expect(resolveKey({ key: 'a', metaKey: true })).toBe('select.all');
  });

  it('撤销与两个重做入口', () => {
    expect(resolveKey({ key: 'z', ctrlKey: true })).toBe('history.undo');
    expect(resolveKey({ key: 'z', ctrlKey: true, shiftKey: true })).toBe('history.redo');
    expect(resolveKey({ key: 'y', ctrlKey: true })).toBe('history.redo');
    // Shift 会改变 key 的大小写，归一化之后仍然命中。
    expect(resolveKey({ key: 'Z', ctrlKey: true, shiftKey: true })).toBe('history.redo');
  });

  it('剪贴板与视图', () => {
    expect(resolveKey({ key: 'c', ctrlKey: true })).toBe('clipboard.copy');
    expect(resolveKey({ key: 'x', ctrlKey: true })).toBe('clipboard.cut');
    expect(resolveKey({ key: 'v', ctrlKey: true })).toBe('clipboard.paste');
    expect(resolveKey({ key: 's', ctrlKey: true })).toBe('doc.save');
    expect(resolveKey({ key: '0', ctrlKey: true })).toBe('view.reset');
    expect(resolveKey({ key: '1', ctrlKey: true })).toBe('view.fit');
  });

  it('Alt 组合一律不拦截（留给系统）', () => {
    expect(resolveKey({ key: 'ArrowLeft', altKey: true })).toBeNull();
    expect(resolveKey({ key: 'z', ctrlKey: true, altKey: true })).toBeNull();
  });

  it('不认识或不该抢的组合返回 null', () => {
    expect(resolveKey({ key: 'r', ctrlKey: true })).toBeNull(); // 浏览器刷新
    expect(resolveKey({ key: 'q' })).toBeNull();
    expect(resolveKey({ key: ' ' })).toBeNull();
    expect(resolveKey({ key: 'Shift', shiftKey: true })).toBeNull();
  });
});
