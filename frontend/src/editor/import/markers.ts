/**
 * 标记（Marker）对照表与映射。
 *
 * docs/03 §5.5 的一期清单。XMind 的 `markerId` 是扁平的（`priority-1` /
 * `task-done`），本项目的 `Marker` 需要 `groupId` + `markerId` 两段，所以要有
 * 一张「分组 → 成员」的表来反查。
 *
 * 放在 import 根目录而不是 xmind 子目录：OPML 的 `_status` / `_priority` /
 * `_icon` 与 Markdown 的任务列表都要映射到同一套标记，各写一份必然走岔。
 */

import type { Marker } from '../model/types';

/**
 * 分组 → 成员。顺序即界面里的分组顺序。
 */
export const MARKER_GROUPS: Record<string, readonly string[]> = {
  priority: [
    'priority-1', 'priority-2', 'priority-3', 'priority-4', 'priority-5',
    'priority-6', 'priority-7', 'priority-8', 'priority-9',
  ],
  task: [
    'task-start', 'task-quarter', 'task-half', 'task-three-quarter',
    'task-done', 'task-pause', 'task-cancel',
  ],
  flag: ['flag-red', 'flag-orange', 'flag-yellow', 'flag-green', 'flag-blue', 'flag-purple', 'flag-gray'],
  star: ['star-red', 'star-orange', 'star-yellow', 'star-green', 'star-blue', 'star-purple'],
  symbol: [
    'symbol-plus', 'symbol-minus', 'symbol-question', 'symbol-exclamation',
    'symbol-info', 'symbol-smile', 'symbol-cry', 'symbol-warning',
  ],
  people: ['people-1', 'people-2', 'people-3', 'people-4', 'people-5'],
};

const MARKER_GROUP_OF = new Map<string, string>();
for (const [group, ids] of Object.entries(MARKER_GROUPS)) {
  for (const id of ids) MARKER_GROUP_OF.set(id, group);
}

/** 认识的标记返回 `Marker`，不认识的返回 null（调用方计入 `marker-unknown`）。 */
export function mapMarker(markerId: string): Marker | null {
  const groupId = MARKER_GROUP_OF.get(markerId);
  if (groupId === undefined) return null;
  return { groupId, markerId };
}
