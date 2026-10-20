/**
 * 导出前的字体回退检测（docs/06 §4.2，验收标准 9）。
 *
 * 「有 N 个字符用了系统字体」这句话必须能说出口。用户看到成品里某个字长得不对、
 * 却不知道为什么，比那个字长什么样糟糕得多——尤其导出常常是发给别人的最后一步。
 *
 * 检测对象是**真正会被画出来的文字**，不是文档里的全部文字：
 *
 * - 主题标题：取 `layout.sizes.lines`（折行后的实际行），不是 `topic.title`——
 *   标题里的 `\n` 在渲染时被拆成多行，取原文会多算换行符。
 * - 边界标题、关系线标题：这两处没有单独的 `font-family`，继承 SVG 根上的
 *   `sans`（见 `export-canvas.tsx`）。
 * - **备注不算**：备注不画在画布上，为它报缺字是误报。
 * - **标签不算**：目前画布不渲染标签（`viewer/` 里没有任何地方读 `topic.labels`），
 *   等标签上画布了要同步加进来。
 *
 * 纯函数：`ExportContext` 里已经有每张画布的布局与解析后的样式，不需要 DOM。
 */

import type { FontFamily } from '../model/types';
import { coverageOf, uncoveredChars } from '../theme/coverage';
import type { ExportContext } from './context';

/** 边界与关系线标题继承的字体族（`ExportCanvas` 的根 `font-family`）。 */
const DECORATION_FAMILY: FontFamily = 'sans';

export interface FallbackReport {
  /** 去重后的缺字，按首次出现顺序。 */
  chars: string[];
  /** 缺字个数（去重后）。 */
  count: number;
}

/**
 * 扫一遍导出上下文，找出内置字体里没有字形的字符。
 *
 * 返回去重后的字符而不是出现次数：提示语是「N 个字符使用了系统字体」，用户关心
 * 的是「哪些字」，重复十次的同一个字报成 10 个没有意义。
 */
export function detectFallback(ctx: ExportContext): FallbackReport {
  const chars: string[] = [];
  const seen = new Set<string>();

  const consider = (text: string, family: FontFamily): void => {
    if (text === '') return;
    const ranges = coverageOf(family);
    // `system` 族没有覆盖表：它本来就是系统字体，不存在「回退」。
    if (ranges === null) return;

    for (const char of uncoveredChars(text, ranges)) {
      if (seen.has(char)) continue;
      seen.add(char);
      chars.push(char);
    }
  };

  for (const sheet of ctx.sheets) {
    for (const box of sheet.layout.boxes.values()) {
      const lines = sheet.layout.sizes.get(box.id)?.lines ?? [];
      const family = sheet.layout.styles.get(box.id)?.fontFamily ?? DECORATION_FAMILY;
      consider(lines.join(''), family);
    }

    for (const boundary of sheet.sheet.boundaries) consider(boundary.title, DECORATION_FAMILY);
    for (const relationship of sheet.sheet.relationships) consider(relationship.title, DECORATION_FAMILY);
  }

  return { chars, count: chars.length };
}
