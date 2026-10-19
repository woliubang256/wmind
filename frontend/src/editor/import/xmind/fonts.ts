/**
 * 字体名归一（docs/03 §5.3.1）。
 *
 * XMind 的 `fo:font-family` 是**字体名**（「源机器上装了什么」），本项目存的是
 * **族标识符**（`sans` / `serif` / `mono` / `system`）。直传字体名的后果是文档里
 * 留着一个在别人机器上必然不存在的引用，同一份文件在不同设备上渲染结果不同。
 *
 * 匹配顺序：精确 → 子串（不区分大小写）→ 回退 `sans`。
 * 规则顺序**有意义**，不能随便调：`serif` 必须排在 `sans-serif` 之后，否则
 * 「sans-serif」会被当成衬线。
 */

import type { FontFamily } from '../../model/types';

export interface FontNormalization {
  family: FontFamily;
  /** false = 没命中任何规则，回退到了 sans。 */
  known: boolean;
  /** true = 命中了「有对应概念但本期没有标识符」的字体（楷体），要额外提示。 */
  degraded: boolean;
}

interface Rule {
  pattern: string;
  family: FontFamily;
  degraded?: boolean;
}

/**
 * 子串规则，**按顺序**匹配。`serif` 放在最后是刻意的：它是 `sans-serif`
 * 的子串，放前面会让所有无衬线字体变成衬线。
 */
const RULES: readonly Rule[] = [
  { pattern: 'nevermind', family: 'sans' },
  { pattern: 'source han sans', family: 'sans' },
  { pattern: 'noto sans', family: 'sans' },
  { pattern: '思源黑体', family: 'sans' },
  { pattern: 'pingfang', family: 'sans' },
  { pattern: '苹方', family: 'sans' },
  { pattern: 'hiragino', family: 'sans' },
  { pattern: 'microsoft yahei', family: 'sans' },
  { pattern: '微软雅黑', family: 'sans' },
  { pattern: 'dengxian', family: 'sans' },
  { pattern: '等线', family: 'sans' },
  { pattern: 'simhei', family: 'sans' },
  { pattern: '黑体', family: 'sans' },
  { pattern: 'helvetica', family: 'sans' },
  { pattern: 'arial', family: 'sans' },
  { pattern: 'roboto', family: 'sans' },
  { pattern: 'segoe ui', family: 'sans' },
  { pattern: 'system-ui', family: 'sans' },
  { pattern: 'sans-serif', family: 'sans' },

  { pattern: 'source han serif', family: 'serif' },
  { pattern: 'noto serif', family: 'serif' },
  { pattern: '思源宋体', family: 'serif' },
  { pattern: 'simsun', family: 'serif' },
  { pattern: '宋体', family: 'serif' },
  { pattern: 'songti', family: 'serif' },
  { pattern: 'times new roman', family: 'serif' },
  { pattern: 'georgia', family: 'serif' },

  // 楷体系：概念上是衬线，本期没有独立标识符，降级为 serif 并提示。
  { pattern: 'kaiti', family: 'serif', degraded: true },
  { pattern: '楷体', family: 'serif', degraded: true },
  { pattern: 'stkaiti', family: 'serif', degraded: true },
  { pattern: 'lxgw', family: 'serif', degraded: true },
  { pattern: '霞鹜文楷', family: 'serif', degraded: true },

  { pattern: 'consolas', family: 'mono' },
  { pattern: 'courier', family: 'mono' },
  { pattern: 'monaco', family: 'mono' },
  { pattern: 'menlo', family: 'mono' },
  { pattern: 'jetbrains mono', family: 'mono' },
  { pattern: 'monospace', family: 'mono' },

  // 兜底：只有前面都没命中才轮到它。
  { pattern: 'serif', family: 'serif' },
];

/** 去掉包裹的引号与多余空白，XMind 里常见 `'PingFang SC'` 这种写法。 */
export function cleanFontName(raw: string): string {
  return raw.trim().replace(/^['"]+|['"]+$/g, '').trim();
}

/**
 * 归一化一个字体名。空字符串返回 `null`——「没写」和「写了不认识的名字」
 * 是两件事：前者该继承主题，后者才该提示。
 */
export function normalizeFontFamily(raw: string | undefined): FontNormalization | null {
  if (raw === undefined) return null;
  const name = cleanFontName(raw);
  if (name === '') return null;

  const lower = name.toLowerCase();
  // 精确匹配先走一遍：名字正好等于规则时不必依赖子串顺序。
  for (const rule of RULES) {
    if (rule.pattern === lower) {
      return { family: rule.family, known: true, degraded: rule.degraded === true };
    }
  }
  for (const rule of RULES) {
    if (lower.includes(rule.pattern)) {
      return { family: rule.family, known: true, degraded: rule.degraded === true };
    }
  }
  return { family: 'sans', known: false, degraded: false };
}
