import { describe, expect, it } from 'vitest';
import { INSERT_ACTIONS, insertAvailability } from './insert-actions';

describe('Insert 选区规则', () => {
  it('无选区全部禁用，不以根节点填充；概要与混合选区也不能丢弃对象', () => {
    for (const item of INSERT_ACTIONS) {
      expect(insertAvailability(item, 0, 0)).toBe('selection');
      expect(insertAvailability(item, 0, 1)).toBe('topics');
      expect(insertAvailability(item, 1, 2)).toBe('topics');
      expect(insertAvailability(item, 1, 1)).toBeNull();
    }
  });
  it('单值编辑和可批量插入分开', () => {
    expect(insertAvailability('note', 2, 2)).toBe('single');
    expect(insertAvailability('topic', 2, 2)).toBe('single');
    expect(insertAvailability('todo', 2, 2)).toBeNull();
    expect(insertAvailability('label', 2, 2)).toBeNull();
    expect(insertAvailability('image', 2, 2)).toBeNull();
  });
});
