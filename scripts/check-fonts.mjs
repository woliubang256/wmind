#!/usr/bin/env node
/**
 * 字体分片的完整性闸门（离线，CI 必过）。
 *
 * 缺分片的失败方式极其隐蔽：浏览器不会报错，只是把那几个字画成方框（豆腐块）。
 * 这类缺陷能一路走到用户面前，所以必须在构建期挡住。本脚本核对五件事：
 *
 * 1. **文件在**：manifest 里每个分片都能在磁盘上找到，且字节数与记录一致。
 * 2. **CSS 与 manifest 完全一致**：每族一份 CSS（`<key>.css`），里面的 @font-face
 *    url 指向真实文件；每个 (族, 字重) 的 `unicode-range` 集合与 manifest 逐段
 *    相同；磁盘上没有 manifest 之外的孤儿分片与孤儿 CSS。这条防的是「手改了
 *    CSS」或「重跑脚本只更新了一半」。
 * 3. **覆盖率下限**：ASCII 必须 100%；常用字样本必须 100%；CJK 基本区等区块
 *    给一个下限，防的是整批分片被换成了错误的一套。
 * 4. **不重叠**：只报告不失败。Google 的分片本身就有少量重叠（相邻分片共享
 *    个别码位），这是它的切分方式，不影响渲染。
 * 5. **`font-display: block`**：ADR-016 的硬约束。改成 `swap` 会让首屏先用回退
 *    字体测量、webfont 到达后重排——整张导图跳一下。
 * 6. **前端注册表与 manifest 一致**：`editor/theme/fonts.ts` 的 `weights` 与
 *    `cssPath` 必须与 manifest 对得上。面板给了 600 字重而分片里没有，浏览器会
 *    合成假粗体；`cssPath` 写错则是注入一个 404 后静默回退到系统字体。
 *
 * 为什么第 3 条是「下限」而不是「全覆盖」：U+4E00–U+9FFF 有 20992 个码位，而
 * Noto Sans SC 并没有为其中每个码位都画字形（实测只覆盖 58.4%）。要求全覆盖
 * 等于要求字体做它本来不做的事，闸门会永远红。真正的完整性由第 1、2 条保证：
 * 少一个分片文件、少一条 @font-face 都会红。
 *
 * 用法：node scripts/check-fonts.mjs
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FONT_DIR = join(ROOT, 'frontend/public/fonts');
const MANIFEST_PATH = join(FONT_DIR, 'manifest.json');
const FONT_REGISTRY = join(ROOT, 'frontend/src/editor/theme/fonts.ts');

const failures = [];
const notes = [];
const fail = (message) => failures.push(message);

/**
 * 每个覆盖类别的下限。
 *
 * `min` 取实测值往下留几个百分点的余量：正常重跑脚本不会掉到线下，而一旦
 * 分片被换成别的字体（或少了整批），一定会破线。
 *
 * `mono` 是纯拉丁字体，不要求覆盖 CJK——它的中文由 fontStack 里的系统回退
 * 接住，这是 ADR-016 里 `mono` = 「JetBrains Mono + 系统等宽」的原意。
 */
const COVERAGE = {
  cjk: [
    ['ASCII 可打印', 0x20, 0x7e, 1],
    ['拉丁补充', 0x00a0, 0x00ff, 0.95],
    ['通用标点', 0x2000, 0x206f, 0.4],
    ['CJK 标点', 0x3000, 0x303f, 0.4],
    ['CJK 基本区', 0x4e00, 0x9fff, 0.5],
    ['全角字符', 0xff00, 0xffef, 0.5],
  ],
  latin: [
    ['ASCII 可打印', 0x20, 0x7e, 1],
    ['拉丁补充', 0x00a0, 0x00ff, 0.95],
  ],
};

/** 抽检常用汉字：区块覆盖率达标不代表这些字真的在分片里。 */
const SAMPLE = '的一是了我不人在他有这个上们来到时大地为子中你说生国年着就那和要';

/** 解析 `U+4e00-9fff, U+3000` 这种写法。 */
function parseRanges(value) {
  const ranges = [];
  for (const part of value.split(',')) {
    const token = part.trim();
    if (token === '') continue;
    const match = /^U\+([0-9a-f]+)(?:-([0-9a-f]+))?$/i.exec(token);
    if (!match) throw new Error(`无法解析 unicode-range 片段：${token}`);
    const start = parseInt(match[1], 16);
    const end = match[2] ? parseInt(match[2], 16) : start;
    if (end < start) throw new Error(`unicode-range 起止颠倒：${token}`);
    ranges.push([start, end]);
  }
  return ranges;
}

/** 合并区间，顺带返回重叠段（只用于报告）。 */
function mergeRanges(ranges) {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const merged = [];
  const overlaps = [];
  for (const [start, end] of sorted) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) {
      overlaps.push([start, Math.min(end, last[1])]);
      last[1] = Math.max(last[1], end);
    } else {
      merged.push([start, end]);
    }
  }
  return { merged, overlaps };
}

function coveredBy(merged, codePoint) {
  return merged.some(([start, end]) => codePoint >= start && codePoint <= end);
}

function coverageOf(merged, start, end) {
  let covered = 0;
  for (const [lo, hi] of merged) {
    const from = Math.max(lo, start);
    const to = Math.min(hi, end);
    if (to >= from) covered += to - from + 1;
  }
  return covered / (end - start + 1);
}

/** 把区间集合规范化成可比较的字符串。 */
function canonical(ranges) {
  return [...ranges]
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
    .map(([start, end]) => `${start.toString(16)}-${end.toString(16)}`)
    .join(',');
}

/** 解析一份 CSS 里的 @font-face，顺带校验必填字段与 `font-display`。 */
function parseCss(css, name) {
  const faces = [];
  const faceRe = /@font-face\s*\{([^}]+)\}/g;
  let match;
  while ((match = faceRe.exec(css)) !== null) {
    const body = match[1];
    const family = /font-family:\s*'([^']+)'/.exec(body)?.[1];
    const weight = Number(/font-weight:\s*(\d+)/.exec(body)?.[1]);
    const url = /url\('([^']+)'\)/.exec(body)?.[1];
    const range = /unicode-range:\s*([^;]+);/.exec(body)?.[1];
    const display = /font-display:\s*(\w+)/.exec(body)?.[1];
    if (!family || !weight || !url || !range) {
      fail(`${name}: 有一条 @font-face 字段不全：${body.replace(/\s+/g, ' ').slice(0, 80)}`);
      continue;
    }
    if (display !== 'block') {
      fail(`${name}: ${family} ${weight} 的 font-display 是 ${display}，必须是 block（ADR-016）`);
    }
    faces.push({ family, weight, url, range });
  }
  if (faces.length === 0) fail(`${name}: 一条 @font-face 都没解析到`);
  return faces;
}

function main() {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  } catch (error) {
    console.error(`读取字体产物失败：${error.message}`);
    console.error('跑一次 `node scripts/fetch-fonts.mjs` 生成（需要网络）。');
    process.exit(1);
  }

  // ---- 1. 文件在 ----
  let totalBytes = 0;
  let totalShards = 0;
  for (const family of manifest.families) {
    const dir = join(FONT_DIR, family.key);
    let files = [];
    try {
      files = readdirSync(dir).filter((name) => name.endsWith('.woff2'));
    } catch {
      fail(`${family.key}: 目录不存在（${dir}）`);
      continue;
    }
    const declared = new Set(family.shards.map((shard) => shard.file));
    for (const shard of family.shards) {
      let size;
      try {
        size = statSync(join(dir, shard.file)).size;
      } catch {
        fail(`${family.key}/${shard.file}: manifest 里有，磁盘上没有`);
        continue;
      }
      if (size !== shard.bytes) {
        fail(`${family.key}/${shard.file}: 字节数 ${size} != manifest ${shard.bytes}`);
      }
      totalBytes += size;
      totalShards += 1;
    }
    for (const file of files) {
      if (!declared.has(file)) fail(`${family.key}/${file}: 磁盘上有，manifest 里没有（孤儿文件）`);
    }
  }

  // ---- 2. CSS 与 manifest 完全一致（每族一份，见 fetch-fonts.mjs 的说明） ----
  const expectedCss = new Set(manifest.families.map((family) => `${family.key}.css`));
  for (const file of readdirSync(FONT_DIR).filter((name) => name.endsWith('.css'))) {
    if (!expectedCss.has(file)) {
      fail(`fonts/${file}: 没有对应的字体族（孤儿 CSS，或早期合并版 fonts.css 残留）`);
    }
  }

  for (const family of manifest.families) {
    const name = `${family.key}.css`;
    let css;
    try {
      css = readFileSync(join(FONT_DIR, name), 'utf8');
    } catch {
      fail(`fonts/${name}: 不存在（ensureFonts 会按这个路径注入）`);
      continue;
    }

    const faces = parseCss(css, name);
    for (const face of faces) {
      if (face.family !== family.family) {
        fail(`${name}: 混入了别的字体族 ${face.family}（应只含 ${family.family}）`);
      }
    }

    for (const weight of family.weights) {
      const inCss = faces.filter((face) => face.family === family.family && face.weight === weight);
      if (inCss.length === 0) {
        fail(`${name}: ${family.family} 缺少字重 ${weight} 的 @font-face`);
        continue;
      }
      const cssRanges = inCss.flatMap((face) => parseRanges(face.range));
      const manifestRanges = family.faces
        .filter((face) => face.weight === weight)
        .flatMap((face) => parseRanges(face.unicodeRange));
      if (canonical(cssRanges) !== canonical(manifestRanges)) {
        fail(
          `${name}: ${family.family} ${weight} 的 unicode-range 与 manifest 不一致` +
            `（CSS ${cssRanges.length} 段 / manifest ${manifestRanges.length} 段）`,
        );
      }
    }

    const referenced = new Set();
    for (const face of faces) {
      const relative = face.url.replace('/fonts/', '');
      referenced.add(relative);
      try {
        statSync(join(FONT_DIR, relative));
      } catch {
        fail(`${name}: ${face.url} 指向的文件不存在`);
      }
    }
    for (const shard of family.shards) {
      if (!referenced.has(`${family.key}/${shard.file}`)) {
        fail(`${name}: 没有引用 ${family.key}/${shard.file}`);
      }
    }
  }

  // ---- 3/4. 覆盖率下限与重叠报告 ----
  for (const family of manifest.families) {
    const ranges = [];
    for (const shard of family.shards) {
      try {
        ranges.push(...parseRanges(shard.unicodeRange));
      } catch (error) {
        fail(`${family.key}/${shard.file}: ${error.message}`);
      }
    }
    const { merged, overlaps } = mergeRanges(ranges);
    if (overlaps.length > 0) {
      notes.push(
        `${family.key}: ${overlaps.length} 段码位被相邻分片重复声明（Google 的切分方式，不影响渲染）`,
      );
    }

    const rules = COVERAGE[family.coverage ?? 'cjk'];
    if (!rules) {
      fail(`${family.key}: 未知的 coverage 取值 ${family.coverage}`);
      continue;
    }
    for (const [label, start, end, min] of rules) {
      const ratio = coverageOf(merged, start, end);
      if (ratio < min) {
        fail(
          `${family.key}: ${label} 覆盖率 ${(ratio * 100).toFixed(1)}% ` +
            `低于下限 ${(min * 100).toFixed(0)}%`,
        );
      }
    }
    if ((family.coverage ?? 'cjk') !== 'latin') {
      for (const char of SAMPLE) {
        if (!coveredBy(merged, char.codePointAt(0))) {
          fail(`${family.key}: 常用字「${char}」不在任何分片里`);
        }
      }
    }
  }

  // ---- 6. 前端注册表与 manifest 一致 ----
  //
  // 只做「够用的解析」：正则抓 id / cssPath / weights 三个字段。它是闸门不是
  // 编译器——抓不到（字段顺序改了、写法变了）会直接红，不会静默放过。
  let registrySource = '';
  try {
    registrySource = readFileSync(FONT_REGISTRY, 'utf8');
  } catch (error) {
    fail(`读不到前端字体注册表：${error.message}`);
  }
  if (registrySource !== '') {
    const registry = new Map();
    const entryRe = /id:\s*'([a-z]+)'[\s\S]*?cssPath:\s*(null|'([^']+)')[\s\S]*?weights:\s*\[([^\]]*)\]/g;
    for (const match of registrySource.matchAll(entryRe)) {
      registry.set(match[1], {
        cssPath: match[2] === 'null' ? null : match[3],
        weights: match[4]
          .split(',')
          .map((part) => Number(part.trim()))
          .filter((value) => Number.isFinite(value) && value > 0),
      });
    }
    if (registry.size === 0) {
      fail('前端注册表解析不到任何字体族（fonts.ts 的字段顺序或写法变了？）');
    }

    for (const family of manifest.families) {
      const entry = registry.get(family.key);
      if (!entry) {
        fail(`前端注册表缺少 ${family.key}`);
        continue;
      }
      if (entry.cssPath !== `/fonts/${family.key}.css`) {
        fail(`前端注册表 ${family.key}.cssPath 是 ${entry.cssPath}，应为 /fonts/${family.key}.css`);
      }
      if (entry.weights.join(',') !== family.weights.join(',')) {
        fail(
          `前端注册表 ${family.key}.weights 是 [${entry.weights.join(', ')}]，` +
            `manifest 是 [${family.weights.join(', ')}]`,
        );
      }
    }
  }

  if (failures.length > 0) {
    console.error(`字体分片校验失败（${failures.length} 项）：`);
    for (const message of failures) console.error(`  - ${message}`);
    process.exit(1);
  }

  const weights = manifest.families.map((f) => `${f.key} ${f.weights.length}`).join(' / ');
  console.log(
    `字体 ${manifest.families.length} 族（${weights} 字重），` +
      `${totalShards} 分片 / ${(totalBytes / 1024 / 1024).toFixed(2)} MB，` +
      'ASCII 与常用字全覆盖',
  );
  for (const note of notes) console.log(`  · ${note}`);
}

main();
