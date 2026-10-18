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

export interface FontDefinition {
  id: FontFamily;
  /** 界面里显示的名字。 */
  label: string;
  /** CSS font-family 值，含完整的回退链。 */
  stack: string;
  /** 是否随应用分发字体文件（决定首屏是否需要等 `document.fonts.load`）。 */
  bundled: boolean;
}

export const FONT_DEFINITIONS: Record<FontFamily, FontDefinition> = {
  sans: {
    id: 'sans',
    label: '思源黑体',
    stack: "'Noto Sans SC', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', system-ui, sans-serif",
    bundled: true,
  },
  system: {
    id: 'system',
    label: '跟随系统',
    stack: "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif",
    bundled: false,
  },
  serif: {
    id: 'serif',
    label: '思源宋体',
    stack: "'Noto Serif SC', 'Songti SC', SimSun, Georgia, serif",
    bundled: true,
  },
  mono: {
    id: 'mono',
    label: '等宽',
    stack: "'JetBrains Mono', 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace",
    bundled: true,
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
