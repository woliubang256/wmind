/**
 * 样式解析：`topic + 上下文 + theme → ComputedStyle`。
 *
 * 解析顺序（后覆盖前，见 docs/05 §5.1）：
 *
 *   内置兜底 → theme.global → 角色样式（central/main/sub/floating/summary）
 *   → 调色板分配 → topic.style 的显式非 null 字段
 *
 * 关键设计：**调色板颜色不写回文档**。它是在渲染时按 `branchIndex` 算出来的，
 * 只有用户手动指定颜色时才固化进 `topic.style`。这样换配色方案才能整体生效，
 * 而不是「换主题后一半节点还是旧颜色」。
 *
 * 为了正确实现「仅当未被显式指定时才取调色板」，这里必须逐层跟踪哪些字段
 * 已经被显式赋值（`assigned` 集合）。如果简单地从默认值开始一路 Object.assign，
 * 默认值会把「未指定」和「指定为默认值」混为一谈，调色板就永远生效不了。
 */

import type { ComputedStyle, Style, Theme, Topic } from '../model/types';

export interface StyleContext {
  depth: number;
  /** 一级分支序号；根与自由主题为 -1。 */
  branchIndex: number;
  isRoot: boolean;
  isFloating: boolean;
  isSummary: boolean;
}

/** 内置兜底：任何字段都有值，保证 ComputedStyle 不含 undefined。 */
const BUILTIN: ComputedStyle = {
  shape: 'rounded-rect',
  fill: '#FFFFFF',
  fillPattern: 'solid',
  borderColor: '#BDBDBD',
  borderWidth: 1,
  borderStyle: 'solid',
  fontFamily: 'sans',
  fontSize: 14,
  fontWeight: 400,
  fontStyle: 'normal',
  textDecoration: 'none',
  textColor: '#1F1F1F',
  textAlign: 'center',
  width: 160,
  autoWidth: true,
  lineStyle: 'curve',
  lineEnd: 'none',
  lineWidth: 2,
  lineColor: '#BDBDBD',
  rainbowBranch: false,
  backgroundColor: null,
};

const STYLE_KEYS: (keyof ComputedStyle)[] = [
  'shape',
  'fill',
  'fillPattern',
  'borderColor',
  'borderWidth',
  'borderStyle',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'textDecoration',
  'textColor',
  'textAlign',
  'width',
  'autoWidth',
  'lineStyle',
  'lineEnd',
  'lineWidth',
  'lineColor',
  'rainbowBranch',
  'backgroundColor',
];

/**
 * 逐层合并。`null` 是**有效值**（表示「无填充」），必须照抄；
 * `undefined` 才是「未指定」。这是整个函数里最容易写错的一处。
 */
function apply(
  target: ComputedStyle,
  assigned: Set<keyof ComputedStyle>,
  source: Partial<Style> | null | undefined,
): void {
  if (!source) return;
  for (const key of STYLE_KEYS) {
    const value = source[key];
    if (value === undefined) continue;
    assigned.add(key);
    // 逐键赋值，让 TS 自己校验类型，而不是 `Object.assign` 一把梭。
    switch (key) {
      case 'shape': target.shape = value as ComputedStyle['shape']; break;
      case 'fill': target.fill = value as ComputedStyle['fill']; break;
      case 'fillPattern': target.fillPattern = value as ComputedStyle['fillPattern']; break;
      case 'borderColor': target.borderColor = value as string; break;
      case 'borderWidth': target.borderWidth = value as number; break;
      case 'borderStyle': target.borderStyle = value as ComputedStyle['borderStyle']; break;
      case 'fontFamily': target.fontFamily = value as ComputedStyle['fontFamily']; break;
      case 'fontSize': target.fontSize = value as number; break;
      case 'fontWeight': target.fontWeight = value as number; break;
      case 'fontStyle': target.fontStyle = value as ComputedStyle['fontStyle']; break;
      case 'textDecoration': target.textDecoration = value as ComputedStyle['textDecoration']; break;
      case 'textColor': target.textColor = value as string; break;
      case 'textAlign': target.textAlign = value as ComputedStyle['textAlign']; break;
      case 'width': target.width = value as number; break;
      case 'autoWidth': target.autoWidth = value as boolean; break;
      case 'lineStyle': target.lineStyle = value as ComputedStyle['lineStyle']; break;
      case 'lineEnd': target.lineEnd = value as ComputedStyle['lineEnd']; break;
      case 'lineWidth': target.lineWidth = value as number; break;
      case 'lineColor': target.lineColor = value as string; break;
      case 'rainbowBranch': target.rainbowBranch = value as boolean; break;
      case 'backgroundColor': target.backgroundColor = value as ComputedStyle['backgroundColor']; break;
    }
  }
}

function roleStyle(ctx: StyleContext, theme: Theme): Partial<Style> | null {
  if (ctx.isSummary) return theme.summaryTopic;
  if (ctx.isFloating) return theme.floatingTopic;
  if (ctx.isRoot) return theme.centralTopic;
  if (ctx.depth === 1) return theme.mainTopic;
  return theme.subTopic;
}

const DARK_TEXT = '#1F1F1F';
const LIGHT_TEXT = '#FFFFFF';

/** WCAG 对比度。两个参数都是相对亮度，调用方负责先算好。 */
function contrastRatio(a: number, b: number): number {
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * 按背景亮度选文字颜色。
 *
 * 调色板是固定的 6 个饱和色，其中 #FDD835（黄）上写白字几乎看不清，
 * 而 #E53935（红）上写黑字同样难受。逐个颜色手写「该配什么字色」既枯燥
 * 又会在换配色方案时失效，所以按 WCAG 对比度算：**深灰与白字里选高的那个**。
 *
 * 注意不能按「亮度 > 0.5 用深色」这种阈值拍脑袋：中间调的饱和色两边都勉强，
 * 阈值会把 #E53935（白字 4.2、深字 4.6）判给白字，正好选了差的那个。
 * 选高者永远不劣于阈值法，且能保证所有校准过的配色都 ≥ 4.5:1。
 *
 * 这只是**默认值**：`topic.style.textColor` 显式指定时仍然优先，
 * 用户想强制某个颜色不会被这里覆盖。
 */
function readableTextColor(fill: string | null): string {
  const luminance = relativeLuminance(fill);
  if (luminance === null) return DARK_TEXT;
  const onDark = contrastRatio(luminance, relativeLuminance(DARK_TEXT) ?? 0);
  const onLight = contrastRatio(luminance, 1); // 纯白亮度为 1
  return onDark >= onLight ? DARK_TEXT : LIGHT_TEXT;
}

/** WCAG 相对亮度。解析不了（渐变、颜色名）时返回 null，由调用方兜底。 */
function relativeLuminance(color: string | null): number | null {
  if (!color) return null;
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!match) return null;
  const raw = match[1] ?? '';
  const full = raw.length === 3
    ? raw.split('').map((ch) => ch + ch).join('')
    : raw;
  const channel = (offset: number): number => {
    const value = Number.parseInt(full.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

/**
 * 一级分支取色。
 *
 * **彩虹分支开**：按 `branchIndex` 在 `rainbowColors` 里循环，每条分支一个颜色。
 * **彩虹分支关**：所有分支统一用配色方案的第一色——这正是这个开关的意义所在。
 *
 * 早先的实现是「关掉也用 colors[i % n] 循环」，于是开关两侧结果完全一样，
 * 面板上点它没有任何反馈；而 `palette.colors` 也被 `rainbowColors` 架空，
 * 换配色方案时分支颜色纹丝不动。两种「看起来能点、实际没反应」的控件，
 * 比缺一个控件更让人困惑。
 */
function branchColor(ctx: StyleContext, theme: Theme, key: 'colors' | 'lineColors'): string | null {
  if (ctx.branchIndex < 0) return null;
  const base = key === 'colors' ? theme.palette.colors : theme.palette.lineColors;
  if (!theme.rainbowBranch) return base[0] ?? null;
  const list = theme.rainbowColors.length > 0 ? theme.rainbowColors : base;
  if (list.length === 0) return null;
  const index = ctx.branchIndex % list.length;
  const color = list[index] ?? null;
  // 色板里的浅色填充可配更清楚的线条；用户另外指定的彩虹颜色仍直接使用。
  if (key === 'lineColors' && theme.rainbowColors.length > 0 && color === theme.palette.colors[index]) {
    return theme.palette.lineColors[index % theme.palette.lineColors.length] ?? color;
  }
  return color;
}

export function computeStyle(topic: Topic, ctx: StyleContext, theme: Theme): ComputedStyle {
  const out: ComputedStyle = { ...BUILTIN };
  const assigned = new Set<keyof ComputedStyle>();

  // theme.global 只覆盖四个全局字段（docs/03 §2.5）。
  out.fontFamily = theme.global.fontFamily;
  out.fontSize = theme.global.fontSize;
  out.lineWidth = theme.global.lineWidth;
  out.backgroundColor = theme.global.backgroundColor;
  assigned.add('fontFamily');
  assigned.add('fontSize');
  assigned.add('lineWidth');
  assigned.add('backgroundColor');

  apply(out, assigned, roleStyle(ctx, theme));

  // 调色板：仅当 fill / lineColor 还没被任何一层显式指定时才取色。
  if (!assigned.has('fill')) {
    const color = branchColor(ctx, theme, 'colors');
    if (color) out.fill = color;
  }
  if (!assigned.has('lineColor')) {
    const color = branchColor(ctx, theme, 'lineColors');
    if (color) out.lineColor = color;
  }

  apply(out, assigned, topic.style);

  // 文字颜色没被任何一层显式指定时，按最终填充色的亮度自动选深/浅。
  if (!assigned.has('textColor')) out.textColor = readableTextColor(out.fill);

  // 节点级 rainbowBranch 可以推翻主题设置；但根节点没有分支序号，取不到色，
  // 保持角色样式即可。
  out.rainbowBranch = (topic.style?.rainbowBranch ?? theme.rainbowBranch) && ctx.branchIndex >= 0;

  return out;
}

/**
 * 记忆化缓存。
 *
 * 用 `WeakMap<Theme, Map<key, style>>`：主题对象在 immer 结构共享下引用稳定，
 * 换主题时旧缓存随主题对象一起被 GC，不会无限增长；同一主题内按节点 + 上下文
 * 做二级键。
 */
const CACHE_LIMIT = 5000;
let cache = new WeakMap<Theme, Map<string, ComputedStyle>>();

function cacheKey(topic: Topic, ctx: StyleContext): string {
  return [
    topic.id,
    ctx.depth,
    ctx.branchIndex,
    ctx.isRoot ? 'r' : '',
    ctx.isFloating ? 'f' : '',
    ctx.isSummary ? 's' : '',
    topic.style ? JSON.stringify(topic.style) : '',
  ].join('|');
}

export function resolveStyle(topic: Topic, ctx: StyleContext, theme: Theme): ComputedStyle {
  let perTheme = cache.get(theme);
  if (!perTheme) {
    perTheme = new Map();
    cache.set(theme, perTheme);
  }
  const key = cacheKey(topic, ctx);
  const hit = perTheme.get(key);
  if (hit) return hit;

  const computed = computeStyle(topic, ctx, theme);
  if (perTheme.size >= CACHE_LIMIT) perTheme.clear();
  perTheme.set(key, computed);
  return computed;
}

/** 测试用：丢弃全部缓存。 */
export function clearStyleCache(): void {
  cache = new WeakMap();
}
