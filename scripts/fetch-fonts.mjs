#!/usr/bin/env node
/**
 * 下载并落盘随包分发的字体分片（需要网络，产物入库）。
 *
 * 为什么用 Google Fonts 的现成分片而不是自己跑 pyftsubset：
 *
 * - Noto Sans SC / Noto Serif SC 在 Google Fonts 上是**可变字体**，同一组分片文件
 *   覆盖全部字重（CSS 里每个字重一条 @font-face，指向同一个文件）。101 个分片
 *   就把 4~5 个字重全包了，比自己切 4 遍省 3/4 的体积与构建时间。
 * - 分片的 `unicode-range` 由 Google 按真实使用频率切好，覆盖完整的 CJK 基本区，
 *   不需要我们维护切分表。
 * - 不需要引入 fonttools（Python）或 harfbuzz 的 wasm 构建，CI 上不用装额外工具。
 *
 * 代价：分片文件名带版本号，字体升级时要重跑本脚本，diff 里会出现整批二进制变更。
 * 这是刻意的——字体是构建产物，不是手写源码。
 *
 * 用法：node scripts/fetch-fonts.mjs [--family sans] [--css-only]
 * 产物：frontend/public/fonts/{<family>.css,manifest.json,OFL-*.txt,<family>/*.woff2}
 *
 * **每个字体族一份 CSS**，不是一个总文件：`@font-face` 有 700 多条，合成一份是
 * 700 KB（gzip 218 KB）。而一张导图通常只用一族，合成一份等于让所有人替另外两族
 * 付带宽。拆开之后 `ensureFonts()` 只按需注入当前族的 CSS（见 `font-load.ts`），
 * 顺带也就不需要 index.html 里放一条阻塞渲染的 `<link>`——骨架屏能立刻画出来。
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'frontend/public/fonts');

/**
 * 字体族清单。
 *
 * `weights` 与 `editor/theme/fonts.ts` 的 `FontDefinition.weights` 必须一致——
 * `scripts/check-fonts.mjs` 会核对，改一处不改另一处会红。
 *
 * 为什么 sans 要 600：样式面板的字重下拉给了「中粗 600」。Google 的可变字体能
 * 真实实例化 600，不必让浏览器合成假粗体（假粗体在大字号下会糊成一团）。
 */
const FAMILIES = [
  {
    key: 'sans',
    family: 'Noto Sans SC',
    weights: [300, 400, 600, 700, 800],
    license: 'OFL-noto-cjk.txt',
    // 覆盖率要求交给校验脚本：CJK 族必须覆盖基本区，拉丁族不要求。
    coverage: 'cjk',
  },
  {
    key: 'serif',
    family: 'Noto Serif SC',
    weights: [400, 700],
    license: 'OFL-noto-cjk.txt',
    coverage: 'cjk',
  },
  {
    key: 'mono',
    family: 'JetBrains Mono',
    weights: [400, 700],
    license: 'OFL-jetbrains-mono.txt',
    // 等宽字体只含拉丁与常见符号；中文由 fontStack 里的回退链接住。
    coverage: 'latin',
  },
];

const LICENSES = {
  'OFL-noto-cjk.txt': 'https://raw.githubusercontent.com/notofonts/noto-cjk/main/Sans/LICENSE',
  'OFL-jetbrains-mono.txt':
    'https://raw.githubusercontent.com/JetBrains/JetBrainsMono/master/OFL.txt',
};

// Google Fonts 会按 UA 决定给 woff2 还是 ttf。没有现代 UA 会拿到 ttf，体积翻三倍。
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const only = process.argv.includes('--family')
  ? process.argv[process.argv.indexOf('--family') + 1]
  : null;

async function fetchText(url) {
  const response = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!response.ok) throw new Error(`GET ${url} -> ${response.status}`);
  return response.text();
}

async function fetchBytes(url) {
  const response = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!response.ok) throw new Error(`GET ${url} -> ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

/** 从 URL 里取分片名：Noto 是 `<hash>.<n>.woff2`，JetBrains 是 `<hash>.woff2`。 */
function shardName(url) {
  const indexed = /\.(\d+)\.woff2$/.exec(url);
  if (indexed) return `${indexed[1]}.woff2`;
  const base = url.split('/').pop() ?? 'shard.woff2';
  return base.endsWith('.woff2') ? base : `${base}.woff2`;
}

/** 解析 Google 的 CSS，按 url 归并出分片，按字重归并出 @font-face 引用。 */
function parseFaces(css) {
  const faces = [];
  const blockRe = /@font-face\s*\{([^}]+)\}/g;
  let match;
  while ((match = blockRe.exec(css)) !== null) {
    const body = match[1];
    const weight = /font-weight:\s*(\d+)/.exec(body)?.[1];
    const url = /url\((https:[^)]+)\)/.exec(body)?.[1];
    const range = /unicode-range:\s*([^;]+);/.exec(body)?.[1]?.trim();
    if (!weight || !url || !range) continue;
    faces.push({ weight: Number(weight), url, range });
  }
  return faces;
}

async function buildFamily(spec) {
  const axis = spec.weights.join(';');
  const cssUrl = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(spec.family)}:wght@${axis}&display=block`;
  const css = await fetchText(cssUrl);
  const faces = parseFaces(css);
  if (faces.length === 0) throw new Error(`${spec.family}: CSS 里没有 @font-face`);

  const missing = spec.weights.filter((w) => !faces.some((f) => f.weight === w));
  if (missing.length > 0) throw new Error(`${spec.family}: 缺少字重 ${missing.join(', ')}`);

  const byUrl = new Map();
  for (const face of faces) {
    const file = shardName(face.url);
    if (!byUrl.has(face.url)) byUrl.set(face.url, { file, range: face.range, bytes: 0 });
  }

  const dir = join(OUT_DIR, spec.key);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  // 8 路并发：101 个分片串行要十几秒，全并发又容易被 CDN 限速。
  const entries = [...byUrl.entries()];
  const shards = [];
  for (let i = 0; i < entries.length; i += 8) {
    const batch = entries.slice(i, i + 8);
    await Promise.all(
      batch.map(async ([url, info]) => {
        const bytes = await fetchBytes(url);
        writeFileSync(join(dir, info.file), bytes);
        shards.push({ file: info.file, bytes: bytes.byteLength, unicodeRange: info.range });
      }),
    );
  }

  // 排序后再输出：并发下载完成顺序不定，不排序的话每次生成都会产生无关 diff。
  shards.sort((a, b) => a.file.localeCompare(b.file, 'en', { numeric: true }));

  return {
    key: spec.key,
    family: spec.family,
    weights: spec.weights,
    coverage: spec.coverage,
    faces: faces.map((f) => ({ weight: f.weight, file: shardName(f.url), unicodeRange: f.range })),
    shards,
    source: cssUrl,
    license: spec.license,
  };
}

/** 单族的 CSS。刻意不含其它族——按族拆开是为了让首屏只下载用到的那一族。 */
function renderCss(family) {
  const lines = [
    '/* 由 scripts/fetch-fonts.mjs 生成，勿手改。改字体族清单请改脚本后重跑。 */',
    '/*',
    ' * font-display: block —— 刻意不用 swap。',
    ' * 布局引擎用 Canvas 测量文本：若先用回退字体测量、webfont 到达后重排，',
    ' * 整张导图的节点尺寸都会变、画面会跳一下（ADR-016 第 6 条）。',
    ' * 首屏由 editor 的 ensureFonts() 阻塞等待所需分片，等待期显示骨架屏。',
    ' */',
    '',
  ];
  for (const weight of family.weights) {
    for (const face of family.faces.filter((f) => f.weight === weight)) {
      lines.push(
        '@font-face {',
        `  font-family: '${family.family}';`,
        '  font-style: normal;',
        `  font-weight: ${weight};`,
        '  font-display: block;',
        `  src: url('/fonts/${family.key}/${face.file}') format('woff2');`,
        `  unicode-range: ${face.unicodeRange};`,
        '}',
      );
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

/**
 * 落盘每族一份 CSS，并删掉早期的合并版 `fonts.css`。
 *
 * 合并版留着不会有人引用，但会让人误以为它才是入口——删掉比留注释更清楚。
 */
function writeCss(families) {
  for (const family of families) {
    writeFileSync(join(OUT_DIR, `${family.key}.css`), renderCss(family));
  }
  rmSync(join(OUT_DIR, 'fonts.css'), { force: true });
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  const manifestPath = join(OUT_DIR, 'manifest.json');

  // 只重写 CSS（改注释、改排版）时不必重下 10 MB 分片。分片本身没变，产物等价。
  if (process.argv.includes('--css-only')) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    writeCss(manifest.families);
    console.log(`已按 manifest 重写 ${manifest.families.length} 份 CSS → ${OUT_DIR}`);
    return;
  }

  const specs = only ? FAMILIES.filter((f) => f.key === only) : FAMILIES;
  if (specs.length === 0) throw new Error(`未知字体族 ${only}；可选：${FAMILIES.map((f) => f.key).join(', ')}`);

  const built = [];
  for (const spec of specs) {
    process.stdout.write(`${spec.family} … `);
    const family = await buildFamily(spec);
    built.push(family);
    const total = family.shards.reduce((sum, s) => sum + s.bytes, 0);
    console.log(`${family.shards.length} 分片 / ${(total / 1024 / 1024).toFixed(2)} MB`);
  }

  // 只重建某一族时，其余族从已有 manifest 里沿用，避免把别的族写丢。
  let families = built;
  if (only) {
    const previous = JSON.parse(readFileSync(manifestPath, 'utf8'));
    families = FAMILIES.map((spec) => built.find((b) => b.key === spec.key) ?? previous.families.find((f) => f.key === spec.key)).filter(Boolean);
  }

  writeCss(families);
  writeFileSync(
    manifestPath,
    `${JSON.stringify({ generatedBy: 'scripts/fetch-fonts.mjs', families }, null, 2)}\n`,
  );

  for (const [file, url] of Object.entries(LICENSES)) {
    if (!families.some((f) => f.license === file)) continue;
    writeFileSync(join(OUT_DIR, file), await fetchText(url));
  }

  const totalBytes = families.reduce((sum, f) => sum + f.shards.reduce((s, x) => s + x.bytes, 0), 0);
  console.log(`\n合计 ${(totalBytes / 1024 / 1024).toFixed(2)} MB → ${OUT_DIR}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
