/**
 * 19 套参考配色，以及旧版本的隐藏兼容项。
 *
 * 数据在 `palettes.json`（docs/06 §5.4 要求的「落库为内嵌 JSON」），本文件只做
 * 类型标注与「配色 → 完整 Theme」的装配。分开的理由：色值是**校准产物**，
 * 会被脚本读写（`scripts/check-palette-contrast.mjs`），放在 `.ts` 里脚本就得
 * 解析 TypeScript；放在 `.json` 里两边都能直接读。
 *
 * 每套配色只声明**差异**：分支色 + 中心主题的主色 + 三个角色样式。其余
 * 角色（自由主题、概要、边界、关系线）与布局开关由 `themeFromPalette` 用一份
 * 共享底稿补齐，避免每套配色重复维护同一份默认值。
 */

import type { Style, Theme, ThemePalette } from '../model/types';
import data from './palettes.json';

export interface PaletteDefinition {
  id: string;
  name: string;
  nameEn: string;
  category: 'vivid' | 'classic';
  /** 旧版本兼容项：仍可查找和导入，不出现在色板选择器。 */
  legacy?: boolean;
  /** 分支填充色，按 `branchIndex` 循环。 */
  colors: string[];
  /** 分支线条色，通常与 `colors` 一致。 */
  lineColors: string[];
  backgroundColor: string;
  centralTopic: Partial<Style>;
  mainTopic: Partial<Style>;
  subTopic: Partial<Style>;
}

const ALL_PALETTES = data as PaletteDefinition[];

export const BUILTIN_PALETTES = ALL_PALETTES.filter((palette) => !palette.legacy);
export const LEGACY_PALETTES = ALL_PALETTES.filter((palette) => palette.legacy);

export const PALETTE_IDS = BUILTIN_PALETTES.map((palette) => palette.id);

/** 默认配色（新建导图用）。 */
export const DEFAULT_PALETTE_ID = 'vivid-dawn';

export function paletteById(id: string): PaletteDefinition | undefined {
  return ALL_PALETTES.find((palette) => palette.id === id);
}

export function paletteOrDefault(id: string | null | undefined): PaletteDefinition {
  return (id ? paletteById(id) : undefined) ?? paletteById(DEFAULT_PALETTE_ID) ?? BUILTIN_PALETTES[0]!;
}

/**
 * 共享底稿：所有配色共用的角色样式与布局开关。
 *
 * 这些值来自 docs/03 §2.5 的默认主题示例。它们不属于「配色」——换配色方案
 * 不该改变概要的斜体、边界虚线或自动平衡开关。
 */
const BASE_ROLES = {
  floatingTopic: {
    shape: 'rounded-rect',
    fontSize: 14,
    fill: '#FFF8E1',
    borderColor: '#FFB300',
    borderWidth: 1,
  },
  summaryTopic: {
    shape: 'underline',
    fontSize: 13,
    fontStyle: 'italic',
    textColor: '#616161',
  },
  boundary: { borderColor: '#999999', borderStyle: 'dash', fill: '#F5F5F5' },
  relationship: { lineColor: '#999999', lineWidth: 1, lineEnd: 'arrow' },
} satisfies Record<string, Partial<Style>>;

export const DEFAULT_LAYOUT: Theme['layout'] = {
  autoBalance: true,
  compact: false,
  alignSiblings: false,
  freeBranch: false,
  flexibleFloating: false,
  topicOverlap: false,
};

/** 把一套配色装配成完整 Theme。每次返回**新对象**，避免调用方改到共享数据。 */
export function themeFromPalette(palette: PaletteDefinition): Theme {
  const paletteData: ThemePalette = {
    colors: [...palette.colors],
    lineColors: [...palette.lineColors],
    backgroundColor: palette.backgroundColor,
  };

  return {
    id: palette.id,
    name: palette.name,
    category: palette.category,
    palette: paletteData,
    global: {
      fontFamily: 'sans',
      fontSize: 14,
      lineWidth: 2,
      backgroundColor: palette.backgroundColor,
    },
    centralTopic: { ...palette.centralTopic },
    mainTopic: { ...palette.mainTopic },
    subTopic: { ...palette.subTopic },
    floatingTopic: { ...BASE_ROLES.floatingTopic },
    summaryTopic: { ...BASE_ROLES.summaryTopic },
    boundary: { ...BASE_ROLES.boundary },
    relationship: { ...BASE_ROLES.relationship },
    rainbowBranch: true,
    // 彩虹序列默认跟随配色：换配色方案时「彩虹分支」也要一起变，
    // 否则用户会看到分支填充变了、线条还是上一套的颜色。
    rainbowColors: [...palette.colors],
    layout: { ...DEFAULT_LAYOUT },
  };
}

export function themeById(id: string): Theme {
  return themeFromPalette(paletteOrDefault(id));
}

/**
 * 换配色方案：保留用户在当前主题上改过的「非配色」字段。
 *
 * 直接整份替换会把用户调过的全局字体、线宽、背景色、布局开关一起冲掉——
 * 这些是用户在「画布」面板里显式设置过的，换配色不该是「恢复出厂设置」。
 */
export function applyPalette(current: Theme, palette: PaletteDefinition): Theme {
  const next = themeFromPalette(palette);
  return {
    ...next,
    global: {
      ...next.global,
      fontFamily: current.global.fontFamily,
      fontSize: current.global.fontSize,
      lineWidth: current.global.lineWidth,
      backgroundColor: current.global.backgroundColor,
    },
    palette: { ...next.palette, backgroundColor: current.global.backgroundColor },
    rainbowBranch: current.rainbowBranch,
    layout: { ...current.layout },
  };
}
