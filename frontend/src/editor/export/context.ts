/**
 * 导出选项与导出上下文。
 *
 * 一条硬约束：**导出不复用画布当前的视口**。用户导出时可能正缩到 40% 看全局，
 * 也可能平移到了某个角落；把那个状态带进导出，导出的图片就会跟着歪。所以
 * 导出时对每个画布**重新跑一遍布局**（`layoutMindmap` 是纯函数），从内容本身
 * 算包围盒，与视口完全无关。
 *
 * 另一条：**上下文里不放 DOM**。`buildExportContext` 在 node 环境下就能跑，
 * 尺寸计算、多画布拼接、留白这些容易出错的算术可以纯函数测试；真正的
 * 序列化交给 `svg.ts`。
 */

import { layoutMindmap } from '../layout/mindmap';
import type { LayoutResult, Rect } from '../layout/types';
import type { Sheet, Theme, WmindDocument } from '../model/types';

/** 会产出文件的导出格式。 */
export type ExportFormat = 'svg' | 'png' | 'jpeg' | 'md' | 'opml';
/** 纯文本格式：从文档模型直接序列化，不经过布局与渲染，因此没有尺寸、留白、背景。 */
export type TextExportFormat = 'md' | 'opml';

/** 是否是文本格式。对话框靠它决定隐藏哪些选项、预览换成文本。 */
export function isTextFormat(format: ExportFormat): format is TextExportFormat {
  return format === 'md' || format === 'opml';
}

/** 边框预设。`none` 表示不画。 */
export type BorderStyleId = 'none' | 'thin' | 'red' | 'orange' | 'green' | 'blue';

export interface BorderPreset {
  id: BorderStyleId;
  /** 描边色；`null` 表示不画边框。 */
  stroke: string | null;
  width: number;
  /**
   * 底色；`null` 表示不填。
   *
   * 「绿底」「蓝底」这类预设不只是描边换色——截图里它们是**带底色的一块板**。
   * 底色与「透明背景」互斥，对话框在选中这类预设时会把透明背景关掉并禁用，
   * 否则用户会看到「勾着透明却是绿底」这种自相矛盾的状态。
   */
  fill: string | null;
}

/**
 * 六个边框预设。
 *
 * 色值是**暂定值**：docs/06 §3.7 记的「预设色值需按截图采样校准」还没有做，
 * 这里的红/橙/绿/蓝取的是与主题色系协调的中性色，不是从截图里吸出来的。
 * 校准只需要改这张表，`border` 的传递链路不用动。
 */
export const BORDER_PRESETS: Record<BorderStyleId, BorderPreset> = {
  none: { id: 'none', stroke: null, width: 0, fill: null },
  thin: { id: 'thin', stroke: '#D9D9D9', width: 1, fill: null },
  red: { id: 'red', stroke: '#E54D42', width: 2, fill: null },
  orange: { id: 'orange', stroke: '#F5A623', width: 2, fill: null },
  green: { id: 'green', stroke: '#2E9E5B', width: 2, fill: '#F1FAF4' },
  blue: { id: 'blue', stroke: '#2F6FE4', width: 2, fill: '#EFF5FF' },
};

/** 预设是否自带底色（决定要不要禁用「透明背景」）。 */
export function presetHasFill(id: BorderStyleId): boolean {
  return BORDER_PRESETS[id].fill !== null;
}

/**
 * 自定义倍率的范围。
 *
 * 0.5 以下不如直接看画布；8 以上基本一定撞上浏览器的位图尺寸上限（`raster.ts`
 * 的闸门会拦住），留着只会让人点一次「太大」。上限不是安全边界，只是别让输入框
 * 变成一个能填 100 的地方。
 */
export const SCALE_MIN = 0.5;
export const SCALE_MAX = 8;

/**
 * 把任意输入夹到合法倍率。
 *
 * 保留一位小数：`0.30000000000000004` 这种值出现在输入框里像是程序出错。
 * 非数值（空输入框、用户敲了个 `-`）退回默认倍率，而不是 0——0 会让画布变成
 * 0×0，再撞上 `MIN_CONTENT_SIZE` 的兜底，用户看到的是一个莫名其妙的尺寸。
 */
export function clampScale(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_EXPORT_OPTIONS.scale;
  return Math.round(Math.min(SCALE_MAX, Math.max(SCALE_MIN, value)) * 10) / 10;
}

export interface ExportOptions {
  /** 只导当前画布，还是把所有画布拼成一张。 */
  scope: 'current' | 'all';
  /**
   * 输出格式。
   *
   * 放进选项而不是留给下载那一步，是因为它会影响**背景**：JPEG 没有 alpha
   * 通道，勾了「透明背景」也只能填白。如果背景在上下文里还是透明的、等到
   * 编码时才补白，预览与成品就会不一致——而预览与成品一致是这个功能的底线。
   */
  format: ExportFormat;
  /**
   * 输出倍率。
   *
   * SVG 是矢量，倍率只影响 `width` / `height` 属性（以及 PNG 的栅格化尺寸）；
   * 但对 PNG 来说它是唯一的清晰度开关，所以默认给 2 而不是 1。
   */
  scale: number;
  /** 内容四周的额外留白（px，导出坐标系，不含画布自身的布局留白）。 */
  padding: number;
  /** 透明背景。JPEG 不支持透明，栅格化时会强制填白。 */
  transparent: boolean;
  /** 边框预设（含自带底色的「绿底 / 蓝底」）。 */
  border: BorderStyleId;
  /** 左下角打印导出日期。 */
  date: boolean;
  /** 右下角打印「由 wmind 生成」。 */
  brand: boolean;
}

export const DEFAULT_EXPORT_OPTIONS: ExportOptions = {
  scope: 'current',
  format: 'svg',
  scale: 2,
  padding: 40,
  transparent: false,
  border: 'none',
  date: false,
  brand: true,
};

/** 多画布纵向排列时的间距。 */
export const SHEET_GAP = 48;
/** 有日期 / 品牌标识时底部预留的高度。 */
export const FOOTER_HEIGHT = 28;
/** 内容尺寸的下限：空画布也要导出一张能看的图，而不是 0×0。 */
const MIN_CONTENT_SIZE = 1;

export interface ExportSheet {
  id: string;
  title: string;
  /** 画布本身。装饰层（外框、联系）从它上面读标题与样式。 */
  sheet: Sheet;
  layout: LayoutResult;
  theme: Theme;
  /** 内容包围盒（布局坐标系）。 */
  bounds: Rect;
  /** 这张画布在导出画布里的水平偏移。 */
  offsetX: number;
  /** 这张画布在导出画布里的竖直偏移。 */
  offsetY: number;
}

export interface ExportContext {
  /** 文档标题，用作文件名。 */
  title: string;
  sheets: ExportSheet[];
  /** 导出画布的逻辑尺寸（未乘 scale）。 */
  width: number;
  height: number;
  /** `null` 表示透明背景。 */
  background: string | null;
  /** 边框预设；`none` 时 `stroke` 为 `null`。 */
  border: BorderPreset;
  /** `YYYY-MM-DD`；`null` 表示不打印。 */
  date: string | null;
  brand: boolean;
  scale: number;
}

/**
 * 内容包围盒。
 *
 * 不用 `layout.bounds`：它含布局自己的内边距（默认 80），而导出留白是**另一个
 * 独立参数**。两个叠在一起，用户把留白调成 0 之后仍然会看到 80px 的空边，
 * 只会以为选项没生效。这里从盒子本身算，留白完全由导出选项决定。
 *
 * 连线端点也计入：曲线可能鼓出盒子外面一点，只算盒子会把弧顶裁掉。
 */
export function contentBounds(layout: LayoutResult): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  const consider = (x: number, y: number) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };

  for (const box of layout.boxes.values()) {
    consider(box.x, box.y);
    consider(box.x + box.width, box.y + box.height);
  }
  for (const edge of layout.edges) {
    consider(edge.from.x, edge.from.y);
    consider(edge.to.x, edge.to.y);
  }

  if (!Number.isFinite(minX)) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function today(now: Date): string {
  // 用本地日期而不是 `toISOString()`：后者是 UTC，晚上八点之后东八区会导出
  // 「昨天」的日期。
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function pickSheets(document: WmindDocument, currentSheetId: string | null, scope: ExportOptions['scope']): Sheet[] {
  if (scope === 'all') return document.sheets;
  const current = document.sheets.find((sheet) => sheet.id === currentSheetId);
  return current === undefined ? document.sheets.slice(0, 1) : [current];
}

/**
 * 导出画布的背景色；`null` 表示透明。
 *
 * 三层优先级：预设自带底色 > 透明 > 主题背景。底色排在透明前面，是因为
 * 「绿底」这个预设的语义就是「一块绿板」——选了它再勾透明，两者互相抵消，
 * 界面上没有任何一种结果说得过去。对话框在选中带底色的预设时会关掉并禁用
 * 「透明背景」，这里只是把同一条规则写成代码。
 *
 * JPEG 单独一条分支：它没有 alpha 通道，透明像素会被编码成黑色。勾了「透明
 * 背景」再导 JPEG，唯一说得通的行为是**填白**——而且要在上下文里就填白，
 * 这样预览里看到的白底就是拿到手的白底。
 */
function backgroundColor(theme: Theme, options: ExportOptions): string | null {
  const themeBackground = theme.palette.backgroundColor ?? '#FFFFFF';
  const presetFill = BORDER_PRESETS[options.border].fill;
  if (presetFill !== null) return presetFill;
  if (options.format === 'jpeg') {
    return options.transparent ? '#FFFFFF' : themeBackground;
  }
  return options.transparent ? null : themeBackground;
}

/**
 * 构建导出上下文。
 *
 * `currentSheetId` 找不到时退回第一张画布：调用方传错 id 不该让「导出」直接
 * 失败——导出的是内容，不是 id。
 */
export function buildExportContext(
  document: WmindDocument,
  currentSheetId: string | null,
  options: ExportOptions,
  now: Date = new Date(),
): ExportContext {
  const sheets = pickSheets(document, currentSheetId, options.scope);

  const laid = sheets.map((sheet) => {
    const theme = sheet.themeOverride ?? document.theme;
    const layout = layoutMindmap({ sheet, theme });
    return { sheet, theme, layout, bounds: contentBounds(layout) };
  });

  const innerWidth = laid.reduce((max, item) => Math.max(max, item.bounds.width), 0);
  const innerHeight = laid.reduce((sum, item) => sum + item.bounds.height, 0)
    + Math.max(0, laid.length - 1) * SHEET_GAP;

  const padding = Math.max(0, options.padding);
  const footer = options.date || options.brand ? FOOTER_HEIGHT : 0;

  const width = Math.max(MIN_CONTENT_SIZE, innerWidth + padding * 2);
  const height = Math.max(MIN_CONTENT_SIZE, innerHeight + padding * 2 + footer);

  let cursor = padding;
  const exportSheets: ExportSheet[] = laid.map((item) => {
    const offsetY = cursor;
    cursor += item.bounds.height + SHEET_GAP;
    return {
      id: item.sheet.id,
      title: item.sheet.title,
      sheet: item.sheet,
      layout: item.layout,
      theme: item.theme,
      bounds: item.bounds,
      // 多画布时水平居中：左对齐会让窄画布贴着左边，看起来像被裁掉了一块。
      offsetX: padding + (innerWidth - item.bounds.width) / 2,
      offsetY,
    };
  });

  return {
    title: document.title,
    sheets: exportSheets,
    width,
    height,
    background: backgroundColor(laid[0]?.theme ?? document.theme, options),
    border: BORDER_PRESETS[options.border],
    date: options.date ? today(now) : null,
    brand: options.brand,
    scale: options.scale,
  };
}
