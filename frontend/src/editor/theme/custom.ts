/**
 * 自定义主题的读取与装配。
 *
 * 库里存的是**一整份 Theme**（用户点「保存为我的主题」时的样子），但那份 JSON
 * 可能来自更早的前端版本：缺字段、多字段、或者 `id` 还是某个内置配色的 id。
 * 直接把它当 Theme 用会让 `resolveStyle` 撞上 undefined——一个字段缺失就整张
 * 图变白，而且没有任何报错。
 *
 * 所以读路径统一走 `themeFromCustomConfig`：以默认主题为底稿逐字段补齐，
 * 再把身份三件套（id / name / category）强制改写成本条记录的值。
 *
 * 写路径不需要对应函数：直接把当前 `theme` 当 `config` 发出去，服务端会做
 * 同样的规范化（见 `service/theme.go` 的 `normalizeThemeConfig`）。
 */

import type { Style, Theme, ThemeLayout, ThemePalette } from '@/editor/model/types';
import { DEFAULT_LAYOUT, DEFAULT_PALETTE_ID, themeById } from './palettes';

/** 服务端 `CustomTheme` 里本模块关心的部分。 */
export interface CustomThemeSource {
  uid: string;
  name: string;
  config: Partial<Theme> | null | undefined;
}

/** 角色样式：缺就整块用底稿，有一块就用一块。 */
const ROLE_KEYS = [
  'centralTopic',
  'mainTopic',
  'subTopic',
  'floatingTopic',
  'summaryTopic',
  'boundary',
  'relationship',
] as const satisfies readonly (keyof Theme)[];

function baseTheme(): Theme {
  const theme = themeById(DEFAULT_PALETTE_ID);
  if (!theme) {
    // themeById 只可能返回 undefined 于 palettes.json 被清空；那时整个编辑器
    // 都起不来，早失败比默默用一份空主题好。
    throw new Error('内置配色缺失：palettes.json 至少要有一套配色');
  }
  return theme;
}

function pickColors(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  const colors = value.filter((item): item is string => typeof item === 'string' && item.length > 0);
  return colors.length > 0 ? colors : [...fallback];
}

/**
 * 把一条自定义主题记录装配成可直接使用的 `Theme`。
 *
 * `id` 用记录的 uid 而不是 config 里的 id：内置配色的 id 是稳定的短标识
 * （`classic-rainbow`），拿它当自定义主题的 id，面板的「当前选中」判断会把
 * 两者认成同一个，点一下自定义主题就高亮了内置那套。
 */
export function themeFromCustomConfig(entry: CustomThemeSource): Theme {
  const base = baseTheme();
  const config = entry.config ?? {};
  const palette = (config.palette ?? {}) as Partial<ThemePalette>;
  const colors = pickColors(palette.colors, base.palette.colors);

  const theme: Theme = {
    ...base,
    id: entry.uid,
    name: entry.name,
    category: 'custom',
    palette: {
      colors,
      lineColors: pickColors(palette.lineColors, colors),
      backgroundColor: palette.backgroundColor || base.palette.backgroundColor,
    },
    global: { ...base.global, ...config.global },
    rainbowBranch: config.rainbowBranch ?? base.rainbowBranch,
    rainbowColors: pickColors(config.rainbowColors, colors),
    layout: { ...DEFAULT_LAYOUT, ...(config.layout as Partial<ThemeLayout> | undefined) },
  };

  // 角色样式逐个补：`{...base, ...config}` 在 config 里某个键是显式 undefined
  // 时会把底稿覆盖成 undefined，而 JSON 里的 null 又必须原样保留（null 表示
  // 「这个角色确实没有样式」，与「没存过」不同）。
  for (const key of ROLE_KEYS) {
    const value = config[key];
    theme[key] = (value === undefined ? base[key] : value) as Partial<Style> | null;
  }

  return theme;
}

/** 主题卡片的色带：最多 6 段，与内置配色的缩略图对齐。 */
export function themeSwatchColors(theme: Theme): string[] {
  return theme.palette.colors.slice(0, 6);
}
