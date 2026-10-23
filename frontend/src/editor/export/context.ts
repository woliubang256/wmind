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
import { layoutAnnotations } from '../layout/annotations';
import type { LayoutResult, Rect } from '../layout/types';
import type { Sheet, Theme, WmindDocument } from '../model/types';

/** 会产出文件的导出格式。 */
export type ExportFormat = 'svg' | 'png' | 'jpeg' | 'pdf' | 'md' | 'opml' | 'xmind';
/** 纯文本格式：从文档模型直接序列化，不经过布局与渲染，因此没有尺寸、留白、背景。 */
export type TextExportFormat = 'md' | 'opml';

/** 是否是文本格式。对话框靠它决定预览换成文本、以及跳过栅格化。 */
export function isTextFormat(format: ExportFormat): format is TextExportFormat {
  return format === 'md' || format === 'opml';
}

/**
 * 是否是「文档格式」（交出的是结构，不是一张图）。
 *
 * `xmind` 与两种文本格式在**界面上**是一类：没有倍率、留白、边框、背景可言，
 * 预览也不该是一张渲染图。区别在于 `.xmind` 是二进制 zip、且带图片与样式，
 * 所以它不算 `TextExportFormat`——那个类型承诺了「纯字符串」。
 */
export function isDocumentFormat(format: ExportFormat): boolean {
  return isTextFormat(format) || format === 'xmind';
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

/** 输出长宽比。`auto` 表示完全由内容决定。 */
export type AspectRatioId = 'auto' | '16:9' | '4:3' | '1:1' | '9:16';

/** 每个预设的宽高比；`null` = 不约束。 */
export const ASPECT_RATIOS: Record<AspectRatioId, number | null> = {
  auto: null,
  '16:9': 16 / 9,
  '4:3': 4 / 3,
  '1:1': 1,
  '9:16': 9 / 16,
};

export interface AspectFit {
  width: number;
  height: number;
  /** 内容需要在水平/竖直方向多让出的空间（已取整）。 */
  extraX: number;
  extraY: number;
}

/**
 * 把内容尺寸撑到目标长宽比，**只放大不裁切**。
 *
 * 裁切是另一种产品（「裁剪导出」），这里要的是「给内容加边」：内容永远完整，
 * 只是画布变大、内容居中。
 *
 * 多出来的空间取整后再对称分配（`width + extra * 2`），而不是让两侧各得
 * 小数半格：半像素的偏移在栅格化时会变成一条模糊的边，而且左右不对称本身
 * 就是肉眼可见的缺陷。代价是最终比例可能与目标差 ±1px，可以接受。
 */
export function fitAspect(width: number, height: number, ratio: number | null): AspectFit {
  if (ratio === null || !Number.isFinite(ratio) || ratio <= 0) {
    return { width, height, extraX: 0, extraY: 0 };
  }

  const current = width / height;
  if (current < ratio) {
    // 太窄：加宽。用 `height * ratio` 而不是把 height 缩小——只放大不裁切。
    const extra = Math.round((height * ratio - width) / 2);
    if (extra <= 0) return { width, height, extraX: 0, extraY: 0 };
    return { width: width + extra * 2, height, extraX: extra, extraY: 0 };
  }

  const extra = Math.round((width / ratio - height) / 2);
  if (extra <= 0) return { width, height, extraX: 0, extraY: 0 };
  return { width, height: height + extra * 2, extraX: 0, extraY: extra };
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
  /** 留白（px，导出坐标系，不含画布自身的布局留白）。 */
  padding: number;
  /**
   * 输出长宽比。`auto` 完全由内容决定；其余预设只加边、不裁切。
   *
   * 贴 PPT / 微信朋友圈这类固定版式的场景需要它：16:9 的图直接贴进去不用再
   * 手动裁，比「导出后再到别的软件里对比例」省事得多。
   */
  aspect: AspectRatioId;
  /** 透明背景。JPEG 不支持透明，栅格化时会强制填白。 */
  transparent: boolean;
  /** 边框预设（含自带底色的「绿底 / 蓝底」）。 */
  border: BorderStyleId;
  /** 左下角打印导出日期。 */
  date: boolean;
  /** 右下角打印品牌标识。 */
  brand: boolean;
  /**
   * 品牌标识的文字。
   *
   * 默认值来自站点设置 `site.brand`（导出对话框打开时套用），但**允许当场改**：
   * 同一份导图可能要发给两个客户，各自落款不同。空串等于「不打印」——
   * 勾着开关却写空，页脚那一行就不该占位，见 `buildExportContext`。
   */
  brandText: string;
}

export const DEFAULT_EXPORT_OPTIONS: ExportOptions = {
  scope: 'current',
  format: 'svg',
  scale: 2,
  padding: 40,
  aspect: 'auto',
  transparent: false,
  border: 'none',
  date: false,
  brand: true,
  brandText: 'wmind',
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
  /** 是否打印品牌标识。文字为空时这里是 `false`——空串不该占一行页脚。 */
  brand: boolean;
  /** 品牌标识的文字（已 trim）。`brand` 为 false 时无意义。 */
  brandText: string;
  scale: number;
  /**
   * 内嵌字体的 `@font-face` 规则，写进 SVG 的 `<defs><style>`。
   *
   * 默认空串——「还没有算」。它不是导出选项，而是**异步算出来的产物**：要按
   * 实际用到的字去挑分片、读字节、转 base64。由 `font-embed.ts` 生成后经
   * `applyFontCss` 挂上来，与图片内嵌（`assets.ts`）同一套节奏。
   */
  fontCss: string;
}

/**
 * 内容包围盒。
 *
 * 不用 `layout.bounds`：它含布局自己的内边距（默认 80），而导出留白是**另一个
 * 独立参数**。两个叠在一起，用户把留白调成 0 之后仍然会看到 80px 的空边，
 * 只会以为选项没生效。这里从盒子本身算，留白完全由导出选项决定。
 *
 * 连线端点也计入：曲线可能鼓出盒子外面一点，只算盒子会把弧顶裁掉。
 *
 * `annotations` 是附属结构（概要 / 边界）的包围盒。概要节点挂在最右侧，
 * 不算进来的话，导出的图里它会缺一条边——而画布上看得好好的。
 */
export function contentBounds(layout: LayoutResult, annotations: Rect | null = null): Rect {
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
    consider(box.x + box.width, box.y + (box.outerHeight ?? box.height));
  }
  for (const edge of layout.edges) {
    consider(edge.from.x, edge.from.y);
    consider(edge.to.x, edge.to.y);
  }
  if (annotations !== null) {
    consider(annotations.x, annotations.y);
    consider(annotations.x + annotations.width, annotations.y + annotations.height);
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
    const annotations = layoutAnnotations(sheet, layout, theme);
    return { sheet, theme, layout, bounds: contentBounds(layout, annotations.bounds) };
  });

  const innerWidth = laid.reduce((max, item) => Math.max(max, item.bounds.width), 0);
  const innerHeight = laid.reduce((sum, item) => sum + item.bounds.height, 0)
    + Math.max(0, laid.length - 1) * SHEET_GAP;

  const padding = Math.max(0, options.padding);
  // 勾了「品牌标识」但文字是空的，等于没有落款：这时不该再留一行页脚高度，
  // 否则用户看到的是一块莫名其妙的空白。
  const brandText = options.brandText.trim();
  const brand = options.brand && brandText !== '';
  const footer = options.date || brand ? FOOTER_HEIGHT : 0;

  const baseWidth = Math.max(MIN_CONTENT_SIZE, innerWidth + padding * 2);
  const baseHeight = Math.max(MIN_CONTENT_SIZE, innerHeight + padding * 2 + footer);

  // 长宽比只放大画布，内容居中：多出来的空间对称地分给两侧。
  const fitted = fitAspect(baseWidth, baseHeight, ASPECT_RATIOS[options.aspect]);
  const { width, height, extraX, extraY } = fitted;

  let cursor = padding + extraY;
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
      offsetX: padding + extraX + (innerWidth - item.bounds.width) / 2,
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
    brand,
    brandText,
    scale: options.scale,
    fontCss: '',
  };
}
