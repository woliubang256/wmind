#!/usr/bin/env node
/**
 * 配色对比度校验（docs/06 §5.4 第 3 步、docs/08 §5 验收标准 5）。
 *
 * 读取 `frontend/src/editor/theme/palettes.json`，对每套配色的 6 个分支色与
 * 中心主题填充色，按「深灰 / 白字二选一」的规则算出实际会用的文字色，
 * 要求对比度 ≥ 4.5:1（WCAG AA 正文）。不达标就退出码 1，CI 会拦下来。
 *
 * **算法与 `theme/resolve.ts` 的 `readableTextColor` 必须一致**：那边是运行时
 * 真正决定字色的地方。`palettes.test.ts` 里有一条用例用真实的 `computeStyle`
 * 把同一批色值再跑一遍——脚本负责在 CI 里可见，单测负责防两边漂移。
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = resolve(HERE, '../frontend/src/editor/theme/palettes.json');

const DARK_TEXT = '#1F1F1F';
const LIGHT_TEXT = '#FFFFFF';
const MIN_RATIO = 4.5;

function relativeLuminance(color) {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!match) return null;
  const raw = match[1];
  const full = raw.length === 3 ? raw.split('').map((ch) => ch + ch).join('') : raw;
  const channel = (offset) => {
    const value = Number.parseInt(full.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

function contrastRatio(a, b) {
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/** 与 resolve.ts 同规则：深灰与白字里选对比度高的那个。 */
function pickTextColor(fill) {
  const luminance = relativeLuminance(fill);
  if (luminance === null) return DARK_TEXT;
  const onDark = contrastRatio(luminance, relativeLuminance(DARK_TEXT));
  const onLight = contrastRatio(luminance, 1);
  return onDark >= onLight ? DARK_TEXT : LIGHT_TEXT;
}

const palettes = JSON.parse(readFileSync(DATA, 'utf8'));
const problems = [];

if (!Array.isArray(palettes) || palettes.length !== 10) {
  problems.push(`配色数量应为 10，实际 ${Array.isArray(palettes) ? palettes.length : '非数组'}`);
}

const seen = new Set();
let worstOverall = Infinity;

for (const palette of palettes) {
  const where = palette.id ?? '(缺少 id)';

  if (seen.has(palette.id)) problems.push(`${where}: id 重复`);
  seen.add(palette.id);

  if (!Array.isArray(palette.colors) || palette.colors.length !== 6) {
    problems.push(`${where}: colors 应为 6 个，实际 ${palette.colors?.length ?? 0}`);
    continue;
  }
  if (palette.lineColors?.length !== palette.colors.length) {
    problems.push(`${where}: lineColors 与 colors 长度不一致`);
  }

  const fills = [
    ...palette.colors.map((color, index) => [`colors[${index}]`, color]),
    ['centralTopic.fill', palette.centralTopic?.fill],
  ];

  for (const [label, fill] of fills) {
    if (typeof fill !== 'string' || relativeLuminance(fill) === null) {
      problems.push(`${where}.${label}: 不是合法的 #RGB / #RRGGBB 色值（${fill}）`);
      continue;
    }
    const text = pickTextColor(fill);
    const ratio = contrastRatio(relativeLuminance(fill), relativeLuminance(text));
    worstOverall = Math.min(worstOverall, ratio);
    if (ratio < MIN_RATIO) {
      problems.push(
        `${where}.${label}: ${fill} 上写 ${text} 只有 ${ratio.toFixed(2)}:1（要求 ≥ ${MIN_RATIO}）`,
      );
    }
  }
}

const vivid = palettes.filter((p) => p.category === 'vivid').length;
const classic = palettes.filter((p) => p.category === 'classic').length;
console.log(`配色 ${palettes.length} 套（缤纷 ${vivid} / 经典 ${classic}），最低对比度 ${worstOverall.toFixed(2)}:1`);

if (problems.length > 0) {
  console.error(`\n对比度校验未通过（${problems.length} 项）：`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log('对比度校验通过：全部 ≥ 4.5:1');
