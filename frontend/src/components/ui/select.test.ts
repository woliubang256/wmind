import { describe, expect, it } from 'vitest';
import {
  edgeEnabledIndex,
  nextEnabledIndex,
  placeMenu,
  typeaheadIndex,
  type SelectOption,
} from './select';

const plain: SelectOption[] = [
  { value: 'a', label: 'Apple' },
  { value: 'b', label: 'Banana' },
  { value: 'c', label: 'Cherry' },
];

/** 中间一项禁用，首尾都有：专治「跳过 disabled」与「绕回来」两件事。 */
const withHoles: SelectOption[] = [
  { value: 'a', label: 'Apple' },
  { value: 'b', label: 'Banana', disabled: true },
  { value: 'c', label: 'Cherry' },
  { value: 'd', label: 'Date', disabled: true },
];

describe('nextEnabledIndex', () => {
  it('向下与向上各走一步', () => {
    expect(nextEnabledIndex(plain, 0, 1)).toBe(1);
    expect(nextEnabledIndex(plain, 2, -1)).toBe(1);
  });

  it('首尾相接', () => {
    expect(nextEnabledIndex(plain, 2, 1)).toBe(0);
    expect(nextEnabledIndex(plain, 0, -1)).toBe(2);
  });

  it('跳过 disabled', () => {
    expect(nextEnabledIndex(withHoles, 0, 1)).toBe(2);
    expect(nextEnabledIndex(withHoles, 2, -1)).toBe(0);
  });

  it('从「没有活动项」开始：向下给第一个，向上给最后一个', () => {
    expect(nextEnabledIndex(plain, -1, 1)).toBe(0);
    expect(nextEnabledIndex(plain, -1, -1)).toBe(2);
    expect(nextEnabledIndex(withHoles, -1, -1)).toBe(2);
  });

  it('全部禁用时返回 -1，不原地打转', () => {
    const allOff: SelectOption[] = [
      { value: 'a', label: 'A', disabled: true },
      { value: 'b', label: 'B', disabled: true },
    ];
    expect(nextEnabledIndex(allOff, 0, 1)).toBe(-1);
    expect(nextEnabledIndex(allOff, -1, -1)).toBe(-1);
  });

  it('空列表返回 -1', () => {
    expect(nextEnabledIndex([], -1, 1)).toBe(-1);
  });
});

describe('edgeEnabledIndex', () => {
  it('取第一个与最后一个', () => {
    expect(edgeEnabledIndex(plain, 'first')).toBe(0);
    expect(edgeEnabledIndex(plain, 'last')).toBe(2);
  });

  it('端点禁用时向内让一步', () => {
    const edges: SelectOption[] = [
      { value: 'a', label: 'A', disabled: true },
      { value: 'b', label: 'B' },
      { value: 'c', label: 'C', disabled: true },
    ];
    expect(edgeEnabledIndex(edges, 'first')).toBe(1);
    expect(edgeEnabledIndex(edges, 'last')).toBe(1);
  });

  it('全部禁用与空列表都返回 -1', () => {
    expect(edgeEnabledIndex([{ value: 'a', label: 'A', disabled: true }], 'first')).toBe(-1);
    expect(edgeEnabledIndex([], 'last')).toBe(-1);
  });
});

describe('typeaheadIndex', () => {
  it('按前缀匹配，忽略大小写', () => {
    expect(typeaheadIndex(plain, 'b', -1)).toBe(1);
    expect(typeaheadIndex(plain, 'CH', -1)).toBe(2);
  });

  it('连续敲同一个字母时在同类项之间轮转', () => {
    const fruits: SelectOption[] = [
      { value: '1', label: 'Apple' },
      { value: '2', label: 'Apricot' },
      { value: '3', label: 'Banana' },
    ];
    // 第一次 a 从 -1 往后找 → 第 0 项；第二次 a 从 0 往后找 → 第 1 项。
    expect(typeaheadIndex(fruits, 'a', -1)).toBe(0);
    expect(typeaheadIndex(fruits, 'a', 0)).toBe(1);
    // 到头再绕回第一个。
    expect(typeaheadIndex(fruits, 'a', 1)).toBe(0);
  });

  it('跳过禁用的同前缀项', () => {
    const options: SelectOption[] = [
      { value: '1', label: 'Apple', disabled: true },
      { value: '2', label: 'Apricot' },
    ];
    expect(typeaheadIndex(options, 'a', -1)).toBe(1);
  });

  it('没有匹配、空缓冲、空列表都返回 -1', () => {
    expect(typeaheadIndex(plain, 'z', -1)).toBe(-1);
    expect(typeaheadIndex(plain, '', -1)).toBe(-1);
    expect(typeaheadIndex([], 'a', -1)).toBe(-1);
  });
});

describe('placeMenu', () => {
  const trigger = { top: 100, bottom: 140, left: 40, width: 200 };

  it('下方放得下就向下弹', () => {
    const placement = placeMenu(trigger, 120, { width: 1024, height: 800 });
    expect(placement.above).toBe(false);
    expect(placement.top).toBe(144); // bottom + gap
    expect(placement.left).toBe(40);
    expect(placement.width).toBe(200);
    expect(placement.maxHeight).toBe(120);
  });

  it('下方放不下、上方更宽敞时翻到上面，并让底边贴住触发器', () => {
    const low = { top: 700, bottom: 740, left: 40, width: 200 };
    const placement = placeMenu(low, 200, { width: 1024, height: 800 });
    expect(placement.above).toBe(true);
    expect(placement.top + placement.maxHeight).toBe(696); // top - gap
  });

  it('上方也不宽敞时不翻转，只把高度压到可用空间', () => {
    // 视口只有 400 高、触发器正好在中间：上下各 168，谁也不比谁宽敞。
    const middle = { top: 180, bottom: 220, left: 40, width: 200 };
    const placement = placeMenu(middle, 500, { width: 1024, height: 400 });
    expect(placement.above).toBe(false);
    expect(placement.maxHeight).toBe(400 - 220 - 4 - 8);
  });

  it('高度不超过 maxHeight', () => {
    const placement = placeMenu(trigger, 5000, { width: 1024, height: 2000 });
    expect(placement.maxHeight).toBe(320);
  });

  it('触发器比最小宽度窄时按最小宽度铺开', () => {
    const narrow = { top: 100, bottom: 140, left: 40, width: 60 };
    expect(placeMenu(narrow, 100, { width: 1024, height: 800 }, { minWidth: 160 }).width).toBe(160);
  });

  it('右边超出视口时向左挪，但不越过左边界', () => {
    const right = { top: 100, bottom: 140, left: 900, width: 200 };
    const placement = placeMenu(right, 100, { width: 1024, height: 800 });
    expect(placement.left).toBe(1024 - 200 - 8);
  });

  it('视口比弹层还窄时把宽度压到视口以内', () => {
    const placement = placeMenu({ top: 100, bottom: 140, left: 5, width: 200 }, 100, {
      width: 180,
      height: 800,
    });
    expect(placement.width).toBe(180 - 8 * 2);
    expect(placement.left + placement.width).toBeLessThanOrEqual(180);
  });
});
