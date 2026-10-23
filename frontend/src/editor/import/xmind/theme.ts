/**
 * XMind 主题 → 本项目 Theme。
 *
 * XMind 的主题是「一堆 SVG/CSS 属性的分组」（`map` / `centralTopic` /
 * `mainTopic` / … 每组一个 `properties`），本项目是「校准过的配色方案 +
 * 角色样式」。两者不是同一个模型，所以走两步：
 *
 * 1. **认领一套内置配色**：拿 XMind 主题里的分支色去和可见及兼容配色比对，
 *    命中率够高就用那一套（这样线条色、背景、角色样式的默认值都是校准过的）；
 * 2. **再叠加显式样式**：XMind 明写的属性覆盖到角色样式上——「保留能映射的
 *    显式样式，调色板回退」是 docs/06 §2.1.3 的原话。
 *
 * 为什么不直接把 XMind 的颜色当调色板：内置配色的对比度是算过的
 * （`npm run check:palette`，至少 4.5:1），随手塞进去的一组颜色可能不达标，
 * 而用户看不出「为什么这张图在某些显示器上字看不清」。
 */

import type { Style, Theme } from '../../model/types';
import {
  BUILTIN_PALETTES,
  LEGACY_PALETTES,
  DEFAULT_PALETTE_ID,
  paletteById,
  themeById,
  type PaletteDefinition,
} from '../../theme/palettes';
import type { ImportContext } from '../types';
import { isRecord, read, readColor, type Properties } from './properties';
import { toPartialStyle } from './style';

/** 归一化颜色，只为比对用：`#fff` 与 `#FFFFFF` 必须算同一个。 */
export function normalizeColor(raw: string): string | null {
  const value = raw.trim();
  const short = /^#([0-9a-fA-F]{3})$/.exec(value);
  if (short) {
    const [r, g, b] = (short[1] ?? '').split('');
    return `#${r}${r}${g}${g}${b}${b}`.toUpperCase();
  }
  if (/^#[0-9a-fA-F]{6}$/.test(value)) return value.toUpperCase();
  if (/^(?:rgb|rgba|hsl|hsla)\(/.test(value)) return value.replace(/\s+/g, '').toLowerCase();
  return null;
}

/** `multi-line-colors` 这类字段是一个空格/逗号分隔的颜色列表。 */
function splitColors(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return raw
    .split(/[\s,]+/)
    .map(normalizeColor)
    .filter((value): value is string => value !== null);
}

function collectBranchColors(map: Properties): string[] {
  const out: string[] = [];
  for (const key of ['multi-line-colors', 'multiLineColors', 'color-list']) {
    out.push(...splitColors(read(map, key)));
  }
  return out;
}

export interface PaletteMatch {
  palette: PaletteDefinition;
  /** 命中比例 0..1。0 表示完全对不上。 */
  score: number;
  matched: boolean;
}

/** 命中率阈值。低于这个值就认为「这是另一套配色」，回退并提示。 */
const MATCH_THRESHOLD = 0.5;

/**
 * 用分支色去认领一套内置配色。
 *
 * 评分只看**颜色集合的重合度**，不看背景：内置配色背景都是白的，把
 * 背景算进去等于所有非白底主题都匹配不上，而背景本来就会在第二步被显式
 * 覆盖掉。
 */
export function matchPalette(colors: readonly string[]): PaletteMatch {
  const fallback = paletteById(DEFAULT_PALETTE_ID) ?? BUILTIN_PALETTES[0]!;
  if (colors.length === 0) {
    return { palette: fallback, score: 0, matched: false };
  }

  // 入参可能来自任意调用方（测试、将来的 XMind 8），统一归一化后再比。
  const wanted = new Set(
    colors.map(normalizeColor).filter((value): value is string => value !== null),
  );
  let best = fallback;
  let bestScore = 0;

  for (const palette of [...BUILTIN_PALETTES, ...LEGACY_PALETTES]) {
    const own = new Set(
      palette.colors.map(normalizeColor).filter((value): value is string => value !== null),
    );
    if (own.size === 0) continue;
    let hit = 0;
    for (const color of own) if (wanted.has(color)) hit += 1;
    const score = hit / own.size;
    if (score > bestScore) {
      best = palette;
      bestScore = score;
    }
  }

  return { palette: best, score: bestScore, matched: bestScore >= MATCH_THRESHOLD };
}

interface ThemeGroups {
  map: Properties;
  centralTopic: Properties;
  mainTopic: Properties;
  subTopic: Properties;
  floatingTopic: Properties;
  summaryTopic: Properties;
  boundary: Properties;
  relationship: Properties;
}

/**
 * 取一组 properties。
 *
 * 有的版本把属性直接挂在分组对象上（`centralTopic: { "svg:fill": "#FFF" }`），
 * 有的包一层 `properties`。两种都认，代价是一个 `isRecord` 判断。
 */
function groupProperties(raw: unknown): Properties {
  if (!isRecord(raw)) return {};
  const inner = raw.properties;
  if (isRecord(inner)) return inner;
  return raw as Properties;
}

function readGroups(raw: unknown): ThemeGroups {
  const root = isRecord(raw) ? raw : {};
  return {
    map: groupProperties(root.map),
    centralTopic: groupProperties(root.centralTopic),
    mainTopic: groupProperties(root.mainTopic),
    subTopic: groupProperties(root.subTopic),
    floatingTopic: groupProperties(root.floatingTopic),
    summaryTopic: groupProperties(root.summaryTopic),
    boundary: groupProperties(root.boundary),
    relationship: groupProperties(root.relationship),
  };
}

/** 把显式样式叠到角色样式上。`null` 是「显式无填充」，必须能覆盖掉底稿。 */
function overlay(base: Partial<Style> | null, extra: Partial<Style>): Partial<Style> {
  return { ...(base ?? {}), ...extra };
}

/**
 * 转换主题。`sheet` 的 `theme` 缺失时返回 `null`，让调用方沿用文档主题，
 * 而不是硬造一份「看起来一样但其实是新对象」的主题。
 */
export function toTheme(raw: unknown, ctx: ImportContext): Theme | null {
  if (!isRecord(raw)) return null;

  const groups = readGroups(raw);
  const match = matchPalette(collectBranchColors(groups.map));
  if (!match.matched) {
    // 对不上就回退到默认配色，并明确告诉用户「颜色不是原来的」。
    ctx.warn('palette-fallback');
  }

  const base = themeById(match.palette.id);

  // 背景色单独取：XMind 的 `svg:fill` 在 map 组里表示画布底色。
  const background = readColor(groups.map, 'svg:fill') ?? readColor(groups.map, 'fill');

  return {
    ...base,
    palette: {
      ...base.palette,
      backgroundColor: background ?? base.palette.backgroundColor,
    },
    global: {
      ...base.global,
      backgroundColor: background ?? base.global.backgroundColor,
    },
    centralTopic: overlay(base.centralTopic, toPartialStyle(groups.centralTopic, ctx)),
    mainTopic: overlay(base.mainTopic, toPartialStyle(groups.mainTopic, ctx)),
    subTopic: overlay(base.subTopic, toPartialStyle(groups.subTopic, ctx)),
    floatingTopic: overlay(base.floatingTopic, toPartialStyle(groups.floatingTopic, ctx)),
    summaryTopic: overlay(base.summaryTopic, toPartialStyle(groups.summaryTopic, ctx)),
    boundary: overlay(base.boundary, toPartialStyle(groups.boundary, ctx)),
    relationship: overlay(base.relationship, toPartialStyle(groups.relationship, ctx)),
  };
}
