/**
 * 样式与主题命令。
 *
 * 样式补丁用 `Partial<Style>` 而不是「整份 ComputedStyle」：只写用户真正改动的
 * 字段，其余保持「继承」。这是换主题能整体生效的前提——如果把计算出来的
 * 调色板颜色整份写进 `topic.style`，换配色方案时这些节点就不跟着变了。
 */

import { findTopic } from '../model/traverse';
import type { Style, Theme } from '../model/types';
import { defineCommand, type EditorCommand } from './types';

/** 批量改样式。`null` 值表示「清空该字段、回到继承」。 */
export function updateStyleCommand(ids: readonly string[], patch: Partial<Style>): EditorCommand {
  return defineCommand({
    type: 'style.update',
    label: ids.length > 1 ? `修改 ${ids.length} 个主题样式` : '修改样式',
    apply(draft): void {
      for (const id of ids) {
        const found = findTopic(draft, id);
        if (!found) continue;
        found.topic.style = { ...(found.topic.style ?? {}), ...patch };
      }
    },
  });
}

/** 清空节点级样式，回到完全继承主题。 */
export function resetStyleCommand(ids: readonly string[]): EditorCommand {
  return defineCommand({
    type: 'style.reset',
    label: '清除自定义样式',
    apply(draft): void {
      for (const id of ids) {
        const found = findTopic(draft, id);
        if (!found) continue;
        found.topic.style = {};
      }
    },
  });
}

/** 整体换配色方案。节点级自定义颜色保留——那是用户显式表达过的意图。 */
export function applyThemeCommand(theme: Theme): EditorCommand {
  return defineCommand({
    type: 'theme.apply',
    label: `应用主题「${theme.name}」`,
    apply(draft): void {
      draft.theme = theme;
    },
  });
}
