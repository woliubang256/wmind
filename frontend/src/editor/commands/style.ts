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
        const current = found.topic.style ?? {};
        // 补丁里的每个值都等于现值时**不写回**。写一个内容相同的新对象，
        // immer 仍会判定「改过了」（它比较的是引用），于是重复按同一个样式键
        // 会在历史栈里堆出一串撤销了也看不出差别的空记录。
        const changed = (Object.keys(patch) as (keyof Style)[])
          .some((key) => current[key] !== patch[key]);
        if (!changed) continue;
        found.topic.style = { ...current, ...patch };
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
        // 同上：已经是空样式时不写回，否则「清除样式」按两次会留下两条历史。
        if (Object.keys(found.topic.style ?? {}).length === 0) continue;
        found.topic.style = {};
      }
    },
  });
}

/**
 * 调色板里的下一个填充色；`null` 表示「回到继承」。
 *
 * 传入的 `current` 应当是**渲染出来的**填充色（`resolveStyle().fill`），而不是
 * `topic.style.fill`。原因：一级分支的颜色是渲染期按 `branchIndex` 算出来的，
 * `topic.style.fill` 往往是 null，拿它做起点会让「第一次按键看不到任何变化」
 * ——因为算出来的下一个色恰好就是它已经在显示的那个。
 *
 * 走到列表末尾之后再按一次回到 `null`，让用户能用同一颗键退回继承状态，
 * 不必去记「清除样式」是另一个快捷键。
 */
export function nextFillColor(theme: Theme, current: string | null): string | null {
  const list = theme.palette.colors.length > 0 ? theme.palette.colors : theme.rainbowColors;
  if (list.length === 0) return null;
  const index = current
    ? list.findIndex((color) => color.toLowerCase() === current.toLowerCase())
    : -1;
  if (index === list.length - 1) return null;
  return list[index + 1] ?? list[0] ?? null;
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
