/**
 * 字体注册表：把样式里的**标识符**映射到实际 CSS 字体栈。
 *
 * 文档里存的是 `sans` / `serif` 这类标识符，不是字体名（见 docs/03 §2.4.2）。
 * 这一层是唯一允许把标识符变成 `font-family` 的地方——散落在各处手写
 * `fontFamily: 'Noto Sans SC'` 会让「换字体」变成全局搜索替换。
 *
 * **测量与渲染必须用同一串**：Canvas 的 `measureText` 和 SVG 的 `<text>` 走的是
 * 同一套字体回退链，任何一边改了这里都会导致文字换行位置与实际渲染不一致，
 * 表现为节点宽度对不上文字。所以两边都从 `fontStack()` 取，不各写一份。
 */

import type { FontFamily } from '../model/types';
import { publicAssetUrl } from 'virtual:wmind-public-assets';

export interface FontDefinition {
  id: FontFamily;
  /**
   * 界面里显示的名字（i18n key）。
   *
   * 存 key 而不是名字：这张表是模块级常量，写死中文后切换语言不会跟着变。
   * 注意**不要**把这里当成字体名——真正的字体名在 `stack` 里，`labelKey`
   * 只给下拉框看。
   */
  labelKey: string;
  /** CSS font-family 值，含完整的回退链。 */
  stack: string;
  /** 是否随应用分发字体文件（决定首屏是否需要等 `document.fonts.load`）。 */
  bundled: boolean;
  /**
   * 该族的 `@font-face` 样式表地址；不随包分发的族为 null。
   *
   * 每族一份（`scripts/fetch-fonts.mjs` 生成），由 `ensureFonts()` 按需注入，
   * 不在 index.html 里用 `<link>`——sans.css 是 514 KB（gzip 156 KB），
   * 阻塞渲染等于首屏白屏。详见 `font-load.ts` 的注释。
   */
  cssPath: string | null;
  /**
   * 随包分发的字重。空数组表示该族没有分片（`bundled: false`）。
   *
   * 必须与 `scripts/fetch-fonts.mjs` 的 `FAMILIES[].weights` 一致——
   * `scripts/check-fonts.mjs` 会解析本文件并逐项核对，改一处不改另一处会红。
   */
  weights: number[];
}

export const FONT_DEFINITIONS: Record<FontFamily, FontDefinition> = {
  sans: {
    id: 'sans',
    labelKey: 'editor.font.sans',
    stack: "'Noto Sans SC', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', system-ui, sans-serif",
    bundled: true,
    cssPath: publicAssetUrl('/fonts/sans.css'),
    // 与样式面板的字重下拉对齐：300 细 / 400 常规 / 600 中粗 / 700 粗 / 800 特粗。
    weights: [300, 400, 600, 700, 800],
  },
  system: {
    id: 'system',
    labelKey: 'editor.font.system',
    stack: "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif",
    bundled: false,
    cssPath: null,
    weights: [],
  },
  serif: {
    id: 'serif',
    labelKey: 'editor.font.serif',
    stack: "'Noto Serif SC', 'Songti SC', SimSun, Georgia, serif",
    bundled: true,
    cssPath: publicAssetUrl('/fonts/serif.css'),
    weights: [400, 700],
  },
  mono: {
    id: 'mono',
    labelKey: 'editor.font.mono',
    stack: "'JetBrains Mono', 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace",
    bundled: true,
    cssPath: publicAssetUrl('/fonts/mono.css'),
    weights: [400, 700],
  },
};

export const FONT_IDS: FontFamily[] = ['sans', 'system', 'serif', 'mono'];

export function fontStack(family: FontFamily): string {
  return FONT_DEFINITIONS[family].stack;
}

/** Canvas 的 `font` 简写。字重与字号都必须进来，否则测量结果不可比。 */
export function canvasFont(family: FontFamily, size: number, weight: number, italic = false): string {
  return `${italic ? 'italic ' : ''}${weight} ${size}px ${fontStack(family)}`;
}
