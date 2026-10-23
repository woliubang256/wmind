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
 * - 可见边界、关系线、概要与启用的页脚：没有单独的 `font-family`，继承 SVG
 *   根上的 `sans`（见 `export-canvas.tsx`），字重跟随实际渲染。
 * - **备注不算**：备注不画在画布上，为它报缺字是误报。
 * - 标签、任务与附件：取布局中的 badge / 显示行，采用 sans 400；图标的提示文字不算。
 *
 * 纯函数：`ExportContext` 里已经有每张画布的布局与解析后的样式，不需要 DOM。
 */

import type { FontFamily } from '../model/types';
import { layoutAnnotations } from '../layout/annotations';
import { coverageOf, uncoveredChars } from '../theme/coverage';
import type { ExportContext } from './context';

/** 附加文字及装饰继承的字体族（`ExportCanvas` 的根 `font-family`）。 */
const DECORATION_FAMILY: FontFamily = 'sans';

export interface FallbackReport {
  /** 去重后的缺字，按首次出现顺序。 */
  chars: string[];
  /** 缺字个数（去重后）。 */
  count: number;
}

/** 一段**会被画出来**的文字，连带它用到的字体族与字重。 */
export interface PaintedRun {
  text: string;
  family: FontFamily;
  weight: number;
  style: string;
}

/**
 * 收集画布上真正会画出来的文字段。
 *
 * 字体回退检测与字体内嵌都要用它：两处如果各自扫一遍，迟早会出现「提示说
 * 缺 3 个字、内嵌却漏了第 4 个」这种对不上的状态。
 */
export function paintedRuns(ctx: ExportContext): PaintedRun[] {
  const runs: PaintedRun[] = [];
  const addDecoration = (text: string, weight = 400) => {
    if (text !== '') runs.push({ text, family: DECORATION_FAMILY, weight, style: 'normal' });
  };

  for (const sheet of ctx.sheets) {
    for (const box of sheet.layout.boxes.values()) {
      const size = sheet.layout.sizes.get(box.id);
      const style = sheet.layout.styles.get(box.id);
      const lines = size?.lines ?? [];
      for (const badge of size?.details?.badges ?? []) addDecoration(badge.lines.join(''));
      for (const detail of size?.details?.lines ?? []) addDecoration(detail.text);
      if (lines.length === 0) continue;
      runs.push({
        text: lines.join(''),
        family: style?.fontFamily ?? DECORATION_FAMILY,
        weight: style?.fontWeight ?? 400,
        style: style?.fontStyle ?? 'normal',
      });
    }

    // 与 SVG 共用可见注解：包含主题级结构，排除折叠或隐藏的注解。
    const annotations = layoutAnnotations(sheet.sheet, sheet.layout, sheet.theme);
    for (const boundary of annotations.boundaries) addDecoration(boundary.title, 600);
    for (const relationship of annotations.relationships) addDecoration(relationship.title);
    for (const summary of annotations.summaries) addDecoration(summary.lines.join(''), summary.style.fontWeight);
  }

  if (ctx.date !== null) addDecoration(ctx.date);
  if (ctx.brand) addDecoration(ctx.brandText);

  return runs;
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

  for (const run of paintedRuns(ctx)) {
    const ranges = coverageOf(run.family);
    // `system` 族没有覆盖表：它本来就是系统字体，不存在「回退」。
    if (ranges === null) continue;

    for (const char of uncoveredChars(run.text, ranges)) {
      if (seen.has(char)) continue;
      seen.add(char);
      chars.push(char);
    }
  }

  return { chars, count: chars.length };
}
