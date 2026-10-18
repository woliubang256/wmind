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
  textColor: '#333333',
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

/** 一级分支取色：彩虹开启时用 `rainbowColors`，否则用 `palette.colors`。 */
function branchColor(ctx: StyleContext, theme: Theme, key: 'colors' | 'lineColors'): string | null {
  if (ctx.branchIndex < 0) return null;
  const rainbow = theme.rainbowBranch;
  const list = rainbow
    ? theme.rainbowColors
    : key === 'colors'
      ? theme.palette.colors
      : theme.palette.lineColors;
  if (list.length === 0) return null;
  return list[ctx.branchIndex % list.length] ?? null;
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
