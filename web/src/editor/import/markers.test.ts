/**
 * 标记对照表的测试。
 *
 * 这张表被三个导入器共用（XMind / OPML / Markdown 任务列表），所以它自己必须
 * 是自洽的：一个 markerId 只能属于一个分组，否则 `MARKER_GROUP_OF` 反查会
 * 静默取到「最后写入的那个」，界面上的图标与分组对不上。
 */

import { describe, expect, it } from 'vitest';
import { MARKER_GROUPS, mapMarker } from './markers';

const ALL_IDS = Object.values(MARKER_GROUPS).flat();

describe('MARKER_GROUPS', () => {
  it('没有重复的 markerId', () => {
    expect(new Set(ALL_IDS).size).toBe(ALL_IDS.length);
  });

  it('每个分组名都是 markerId 的前缀', () => {
    for (const [group, ids] of Object.entries(MARKER_GROUPS)) {
      for (const id of ids) {
        // 前缀不一致说明 id 写错了（比如 star-red 落到 flag 组）。
        expect(id.startsWith(`${group}-`) || group === 'priority' || group === 'people').toBe(true);
      }
    }
  });

  it('优先级是 1..9，任务是 7 种状态', () => {
    expect(MARKER_GROUPS.priority).toHaveLength(9);
    expect(MARKER_GROUPS.task).toHaveLength(7);
  });
});

describe('mapMarker', () => {
  it('反查出正确的分组', () => {
    expect(mapMarker('priority-1')).toEqual({ groupId: 'priority', markerId: 'priority-1' });
    expect(mapMarker('task-done')).toEqual({ groupId: 'task', markerId: 'task-done' });
    expect(mapMarker('flag-red')).toEqual({ groupId: 'flag', markerId: 'flag-red' });
    expect(mapMarker('star-blue')).toEqual({ groupId: 'star', markerId: 'star-blue' });
    expect(mapMarker('symbol-warning')).toEqual({ groupId: 'symbol', markerId: 'symbol-warning' });
    expect(mapMarker('people-3')).toEqual({ groupId: 'people', markerId: 'people-3' });
  });

  it('表里每个 id 都能反查回来', () => {
    for (const id of ALL_IDS) {
      expect(mapMarker(id)).not.toBeNull();
    }
  });

  it('不认识的一律 null（调用方计入 marker-unknown）', () => {
    for (const id of ['', 'sticker-smile', 'priority-0', 'priority-10', 'flag-pink', 'TASK-DONE']) {
      expect(mapMarker(id)).toBeNull();
    }
  });

  it('不做模糊匹配：前缀对但后缀不认识也是 null', () => {
    // 「尽力映射」不等于「猜」：猜错比不认更糟，用户会以为标记被保留了。
    expect(mapMarker('task-almost')).toBeNull();
  });
});
