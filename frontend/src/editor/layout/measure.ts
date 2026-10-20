/**
 * 文本测量。
 *
 * 这是内核层唯一允许接触 DOM 的模块：文本宽度只能靠 Canvas 2D 的
 * `measureText` 拿到（SVG 里没有可靠的同步测量手段，`getBBox` 需要已挂载
 * 且会强制 reflow）。
 *
 * 两个必须守住的点：
 *
 * 1. **缓存键必须含字体标识符**。只按文本缓存的话，切换字体或字号后会命中
 *    旧结果，表现为「节点宽度与文字对不上」。缓存键里带 family/size/weight/italic。
 * 2. **测量与渲染必须用同一套字体栈**（见 theme/fonts.ts 的 `canvasFont`），
 *    否则测出来 120px、画出来 140px，同样对不上。
 *
 * 非 DOM 环境（Node 单测）自动退到按字符类别估算的启发式后端，结果确定但
 * 不与浏览器逐像素一致——测试只断言相对关系与折行行为，不断言绝对宽度。
 */

import type { ComputedStyle, FontFamily, Topic, TopicImage } from '../model/types';
import { canvasFont } from '../theme/fonts';
import { IMAGE_METRICS, NODE_METRICS } from './constants';
import type { ImageSize, TopicSize } from './types';

export interface FontSpec {
  family: FontFamily;
  size: number;
  weight: number;
  italic: boolean;
}

export interface MeasureBackend {
  /** 单行文本的宽度（px）。不得折行。 */
  widthOf(text: string, font: FontSpec): number;
}

// ---------------------------------------------------------------------------
// 后端
// ---------------------------------------------------------------------------

/**
 * Canvas 后端。canvas 与 2d context 各只建一次——每次测量都建一个
 * canvas 元素会让 1000 节点布局产生上千次 DOM 分配。
 */
class CanvasBackend implements MeasureBackend {
  private ctx: CanvasRenderingContext2D | null = null;
  private fontKey = '';

  widthOf(text: string, font: FontSpec): number {
    if (text === '') return 0;
    if (!this.ctx) {
      const canvas = document.createElement('canvas');
      this.ctx = canvas.getContext('2d');
      if (!this.ctx) throw new Error('无法创建 2D 画布上下文');
    }
    const key = canvasFont(font.family, font.size, font.weight, font.italic);
    if (key !== this.fontKey) {
      this.ctx.font = key;
      this.fontKey = key;
    }
    return this.ctx.measureText(text).width;
  }
}

/**
 * 启发式后端：没有 DOM 时按字符类别估算。
 *
 * 系数是按思源黑体的实际字宽取的粗略值，够用来判断折行位置与相对宽度。
 * 不要拿它做像素级断言。
 */
class HeuristicBackend implements MeasureBackend {
  widthOf(text: string, font: FontSpec): number {
    let em = 0;
    for (const ch of text) em += charEm(ch);
    return em * font.size * (font.weight >= 600 ? 1.02 : 1);
  }
}

function charEm(ch: string): number {
  const code = ch.codePointAt(0) ?? 0;
  if (code === 0x20) return 0.28;
  if (code === 0x09) return 0.6;
  // CJK 统一表意文字、全角标点、假名、谚文：按一个字宽算。
  if (
    (code >= 0x2e80 && code <= 0x9fff) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xff00 && code <= 0xff60)
  ) {
    return 1;
  }
  if (code >= 0x30 && code <= 0x39) return 0.55; // 数字
  if (code >= 0x41 && code <= 0x5a) return 0.66; // 大写
  if (code >= 0x61 && code <= 0x7a) return 0.54; // 小写
  return 0.42; // 其余标点 / 符号
}

function canUseCanvas(): boolean {
  return typeof document !== 'undefined' && typeof document.createElement === 'function';
}

let backend: MeasureBackend | null = null;

export function defaultBackend(): MeasureBackend {
  if (!backend) backend = canUseCanvas() ? new CanvasBackend() : new HeuristicBackend();
  return backend;
}

/** 测试用：替换后端。传 null 恢复默认。 */
export function setMeasureBackend(next: MeasureBackend | null): void {
  backend = next;
  lineCache.clear();
}

/**
 * 清空测量缓存。
 *
 * 缓存键里只有 `family|size|weight|italic`，**没有**「这族的字体文件到了没有」。
 * 所以字体分片到齐后必须清一次：在此之前量到的宽度用的是回退字体，留着就会
 * 让节点宽度永久偏几像素——这正是 ADR-016 要防的那类错误，只是从「首帧」挪到了
 * 「中途换字体」。见 `features/editor/use-fonts-ready.ts`。
 */
export function clearMeasureCache(): void {
  lineCache.clear();
}

// ---------------------------------------------------------------------------
// 缓存
// ---------------------------------------------------------------------------

const CACHE_LIMIT = 5000;
const lineCache = new Map<string, number>();

function fontKey(font: FontSpec): string {
  return `${font.family}|${font.size}|${font.weight}|${font.italic ? 'i' : 'n'}`;
}

function widthOf(text: string, font: FontSpec, impl: MeasureBackend): number {
  const key = `${fontKey(font)}\u0000${text}`;
  const hit = lineCache.get(key);
  if (hit !== undefined) {
    // Map 的插入顺序即 LRU 顺序：命中后删了再插，把它挪到队尾。
    lineCache.delete(key);
    lineCache.set(key, hit);
    return hit;
  }
  const width = impl.widthOf(text, font);
  if (lineCache.size >= CACHE_LIMIT) {
    const oldest = lineCache.keys().next().value;
    if (oldest !== undefined) lineCache.delete(oldest);
  }
  lineCache.set(key, width);
  return width;
}

/** 测量结果四舍五入到 0.5px：亚像素宽度会让相邻节点看起来「差一点对齐」。 */
function roundHalf(value: number): number {
  return Math.round(value * 2) / 2;
}

// ---------------------------------------------------------------------------
// 折行
// ---------------------------------------------------------------------------

function isCJK(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return (
    (code >= 0x2e80 && code <= 0x9fff) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xff00 && code <= 0xff60)
  );
}

/**
 * 切成折行单元：CJK 逐字（中文可以在任意字之间断行），西文按词，
 * 空格单独成 token（行尾丢弃、行首跳过）。
 */
function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let word = '';
  let space = '';

  const flushWord = () => {
    if (word) {
      tokens.push(word);
      word = '';
    }
  };
  const flushSpace = () => {
    if (space) {
      tokens.push(space);
      space = '';
    }
  };

  for (const ch of text) {
    if (ch === ' ') {
      flushWord();
      space += ch;
      continue;
    }
    flushSpace();
    if (isCJK(ch)) {
      flushWord();
      tokens.push(ch);
    } else {
      word += ch;
    }
  }
  flushWord();
  flushSpace();
  return tokens;
}

function wrapParagraph(
  paragraph: string,
  font: FontSpec,
  maxWidth: number,
  impl: MeasureBackend,
): string[] {
  if (paragraph === '') return [''];
  if (maxWidth <= 0) return [paragraph];

  // 比整行还宽的西文词要按字符硬断，否则会溢出节点。
  const tokens = tokenize(paragraph).flatMap((token) => {
    if (token.trim() === '' || token.length <= 1) return [token];
    return widthOf(token, font, impl) > maxWidth ? [...token] : [token];
  });

  const lines: string[] = [];
  let current = '';
  let currentWidth = 0;

  for (const token of tokens) {
    const isSpace = token.trim() === '';
    if (isSpace && current === '') continue; // 行首不保留空格

    const tokenWidth = widthOf(token, font, impl);
    if (current !== '' && currentWidth + tokenWidth > maxWidth) {
      lines.push(current.trimEnd());
      current = '';
      currentWidth = 0;
      if (isSpace) continue;
    }
    current += token;
    currentWidth += tokenWidth;
  }

  if (current !== '') lines.push(current.trimEnd());
  if (lines.length === 0) lines.push('');
  return lines;
}

export interface MeasuredText {
  width: number;
  height: number;
  lines: string[];
}

/** 折行并测量。`maxWidth` 是内容区宽度（不含节点内边距）。 */
export function measureText(
  text: string,
  font: FontSpec,
  maxWidth: number,
  impl: MeasureBackend = defaultBackend(),
): MeasuredText {
  const paragraphs = text.split('\n');
  const lines: string[] = [];
  for (const paragraph of paragraphs) {
    lines.push(...wrapParagraph(paragraph, font, maxWidth, impl));
  }

  let width = 0;
  for (const line of lines) {
    const w = widthOf(line, font, impl);
    if (w > width) width = w;
  }

  const lineHeight = Math.round(font.size * NODE_METRICS.lineHeightRatio);
  return {
    width: roundHalf(width),
    height: lines.length * lineHeight,
    lines,
  };
}

// ---------------------------------------------------------------------------
// 主题节点
// ---------------------------------------------------------------------------

export function fontOf(style: ComputedStyle): FontSpec {
  return {
    family: style.fontFamily,
    size: style.fontSize,
    weight: style.fontWeight,
    italic: style.fontStyle === 'italic',
  };
}

/**
 * 把图片的声明尺寸夹进可用范围。
 *
 * 等比缩小到 `maxWidth × maxHeight` 之内，再保证不小于 `minSize`。宽高有一个
 * 缺失或非正数时按另一个推 4:3（XMind 的默认比例），两个都没有就按默认尺寸。
 */
export function imageDisplaySize(image: TopicImage): ImageSize {
  const raw = { width: image.width, height: image.height };
  let width = Number.isFinite(raw.width) && raw.width > 0 ? raw.width : 0;
  let height = Number.isFinite(raw.height) && raw.height > 0 ? raw.height : 0;
  if (width === 0 && height === 0) {
    width = 120;
    height = 80;
  } else if (width === 0) {
    width = (height * 4) / 3;
  } else if (height === 0) {
    height = (width * 3) / 4;
  }

  const scale = Math.min(1, IMAGE_METRICS.maxWidth / width, IMAGE_METRICS.maxHeight / height);
  width *= scale;
  height *= scale;

  return {
    src: image.src,
    width: roundHalf(Math.max(IMAGE_METRICS.minSize, width)),
    height: roundHalf(Math.max(IMAGE_METRICS.minSize, height)),
  };
}

/**
 * 测量一个主题节点。
 *
 * 自动宽度：`clamp(内容宽度, 60, 320) + 左右内边距`（docs/05 §4.3）。
 * 固定宽度：直接用 `style.width`，文本按减去内边距后的宽度折行。
 *
 * 有图片时**图片在文本下方**（与 XMind 一致）：盒子宽度取「文本宽」与
 * 「图片宽」的较大者，高度是两段相加。这样文本换行与图片尺寸互不干扰，
 * 也不会出现「图片把文字挤到只剩一个字宽」的排版。
 */
export function measureTopic(
  topic: Topic,
  style: ComputedStyle,
  impl: MeasureBackend = defaultBackend(),
): TopicSize {
  const { paddingX, paddingY, minContentWidth, maxContentWidth, imageGap } = NODE_METRICS;
  const font = fontOf(style);
  const available = style.autoWidth
    ? maxContentWidth
    : Math.max(minContentWidth, style.width - paddingX * 2);

  const measured = measureText(topic.title, font, available, impl);

  const image = topic.image === null ? null : imageDisplaySize(topic.image);

  let width = style.autoWidth
    ? Math.min(maxContentWidth, Math.max(minContentWidth, measured.width)) + paddingX * 2
    : style.width;
  if (image !== null) width = Math.max(width, image.width + paddingX * 2);

  const height = image === null
    ? measured.height + paddingY * 2
    : measured.height + imageGap + image.height + paddingY * 2;

  return {
    width: roundHalf(width),
    height: roundHalf(height),
    lines: measured.lines,
    image,
  };
}
