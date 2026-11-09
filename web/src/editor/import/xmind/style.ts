/**
 * XMind `style.properties` → 本项目 `Partial<Style>`。
 *
 * 两个原则：
 *
 * 1. **只映射表里有的键**（docs/03 §5.3）。表外的属性一律丢弃——XMind 的
 *    属性集随版本增长，猜一个同名映射比丢掉更危险（丢掉的后果是「继承主题」，
 *    猜错的后果是「颜色莫名其妙」）。
 * 2. **返回的是 Partial**：没出现的键不进结果。填默认值会把「继承主题」变成
 *    「显式固化为某个值」，之后换主题就不生效了。
 */

import type {
  BorderStyle,
  FillPattern,
  FontStyleValue,
  LineStyle,
  Style,
  TextAlign,
  TextDecoration,
} from '../../model/types';
import type { ImportContext } from '../types';
import { mapShape } from './mapping';
import { normalizeFontFamily } from './fonts';
import {
  isRecord,
  read,
  readColor,
  readEnum,
  readNumber,
  readPx,
  type Properties,
} from './properties';

const BORDER_STYLES = ['solid', 'dash', 'dot', 'none'] as const;
const FILL_PATTERNS = ['solid', 'none', 'gradient'] as const;
const TEXT_ALIGNS = ['left', 'center', 'right'] as const;
const TEXT_DECORATIONS = ['none', 'underline', 'line-through'] as const;
const FONT_STYLES = ['normal', 'italic'] as const;

/** 线型与虚实是两个维度；几何只能从 line-class / relationshipShape 读取。 */
const LINE_CLASSES: Record<string, LineStyle> = {
  curve: 'curve',
  curved: 'curve',
  straight: 'straight',
  elbow: 'elbow',
  roundedElbow: 'elbow',
  bight: 'elbow',
  fold: 'elbow',
  none: 'none',
};

export type XmindStyleKind = 'topic' | 'relationship' | 'boundary';

function lineClass(value: string | undefined): LineStyle | undefined {
  return value === undefined ? undefined : LINE_CLASSES[value.trim().split('.').pop() ?? ''];
}

function arrowClass(value: string | undefined): Style['lineEnd'] | undefined {
  const name = value?.trim().split('.').pop();
  if (name === 'none') return 'none';
  if (name === 'triangle' || name === 'arrow') return 'arrow';
  if (name === 'circle' || name === 'dot') return 'dot';
  return undefined;
}

/**
 * 转换一组样式属性。
 *
 * `ctx` 用来留痕：字体被归一、渐变被拍平都要让用户看见，否则「导入后字体
 * 变了」会被当成 bug 而不是降级。
 */
export function toPartialStyle(input: unknown, ctx: ImportContext, kind: XmindStyleKind = 'topic'): Partial<Style> {
  if (!isRecord(input)) return {};
  const properties = input as Properties;
  const out: Partial<Style> = {};

  const shape = mapShape(read(properties, 'shape-class'));
  if (shape !== undefined) out.shape = shape;

  const fill = readColor(properties, 'svg:fill');
  if (fill !== undefined) out.fill = fill;

  const pattern = readEnum(properties, 'svg:fill-pattern', FILL_PATTERNS);
  if (pattern !== undefined) {
    if (pattern === 'gradient') {
      // 本项目没有渐变填充：取起始色拍平，`svg:fill` 读到的就是起始色。
      out.fillPattern = 'solid';
      ctx.warn('gradient-flattened');
    } else {
      out.fillPattern = pattern as FillPattern;
    }
  }

  // 主题边框用 border-line-*；外框自身的轮廓才使用 line-*。
  const borderPrefix = kind === 'topic' ? 'border-line' : 'line';
  const borderColor = readColor(properties, `${borderPrefix}-color`);
  if (borderColor !== undefined) out.borderColor = borderColor ?? '#000000';

  const borderWidth = readNumber(properties, `${borderPrefix}-width`);
  if (borderWidth !== undefined) out.borderWidth = borderWidth;

  const borderStyle = readEnum(properties, `${borderPrefix}-pattern`, BORDER_STYLES);
  if (borderStyle !== undefined) out.borderStyle = borderStyle as BorderStyle;

  const rawFamily = read(properties, 'fo:font-family');
  const fontFamily = normalizeFontFamily(rawFamily);
  if (fontFamily !== null) {
    out.fontFamily = fontFamily.family;
    if (!fontFamily.known || fontFamily.degraded) {
      // 不认识的字体名与「楷体降级为宋体」都提示：用户要能解释「为什么字变了」。
      ctx.warn('font-normalized', { from: rawFamily ?? '', to: fontFamily.family });
    }
  }

  const fontSize = readPx(properties, 'fo:font-size');
  if (fontSize !== undefined) out.fontSize = fontSize;

  const weightRaw = read(properties, 'fo:font-weight');
  if (weightRaw !== undefined) {
    const value = weightRaw.trim().toLowerCase();
    if (value === 'bold') out.fontWeight = 700;
    else if (value === 'normal') out.fontWeight = 400;
    else {
      const numeric = Number.parseFloat(value);
      if (Number.isFinite(numeric)) out.fontWeight = Math.round(numeric / 100) * 100;
    }
  }

  const fontStyle = readEnum(properties, 'fo:font-style', FONT_STYLES);
  if (fontStyle !== undefined) out.fontStyle = fontStyle as FontStyleValue;

  const textColor = readColor(properties, 'fo:color');
  if (textColor !== undefined) out.textColor = textColor ?? '#000000';

  const decoration = readEnum(properties, 'fo:text-decoration', TEXT_DECORATIONS);
  if (decoration !== undefined) out.textDecoration = decoration as TextDecoration;

  const align = readEnum(properties, 'fo:text-align', TEXT_ALIGNS);
  if (align !== undefined) out.textAlign = align as TextAlign;

  const lineColor = readColor(properties, 'line-color');
  if (lineColor !== undefined) out.lineColor = lineColor ?? '#000000';

  const lineWidth = readNumber(properties, 'line-width');
  if (lineWidth !== undefined) out.lineWidth = lineWidth;

  const geometry = lineClass(read(properties, kind === 'relationship' ? 'shape-class' : 'line-class'));
  if (geometry !== undefined) out.lineStyle = geometry;
  if (read(properties, 'line-pattern')?.trim() === 'none') out.lineStyle = 'none';

  const starts = arrowClass(read(properties, 'arrow-begin-class'))
    ?? readEnum(properties, 'line-start-marker', ['none', 'arrow', 'dot'] as const);
  if (starts !== undefined) out.lineStart = starts;
  const ends = arrowClass(read(properties, 'arrow-end-class'))
    ?? readEnum(properties, 'line-end-marker', ['none', 'arrow', 'dot'] as const);
  if (ends !== undefined) out.lineEnd = ends;

  return out;
}
