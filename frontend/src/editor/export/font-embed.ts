/**
 * 导出时的字体内嵌（docs/06 §3.4 的「已知保真缺口」）。
 *
 * 导出的 SVG 是独立文件，栅格化走的是 `<img src="data:image/svg+xml…">`——**两条
 * 路都拿不到应用页面里的 `@font-face`**。浏览器会用系统字体去画，于是：
 *
 * - 独立打开 SVG 的人看到的是苹方 / 宋体，不是思源；
 * - PNG 的字宽与画布不同（实测拉丁标题差 16%），节点框是按思源量的，文字会溢出。
 *
 * 解法只有一个：把用到的字体**字节**塞进 SVG。`<img>` 里的 SVG 不许引用外部
 * 资源，但 `data:` 是自身的一部分，不算外部。
 *
 * ## 为什么是「整片」而不是「子集」
 *
 * 理想做法是按用到的字形做子集化，体积能小一个数量级。但那需要解析 woff2
 * （Brotli + glyf 表重排），是一个独立工程；docs/06 §3.5 里给 PDF 规划的
 * `opentype.js` 也做不了 woff2 输入。折中方案是**按分片整片内嵌**：Google 的
 * CJK 切分本来就是按字频分的，常见字集中在少数分片里，一张 200 节点的中文导图
 * 只需要 5 片、约 250 KB（base64 后 340 KB）。代价可接受，收益是「所见即所得」。
 *
 * ## 只嵌用得到的
 *
 * 505 个 face 全嵌进去是 4.5 MB。所以按三件事筛：**字体族**、**字重**、**码位**。
 * 字重这一维很关键——思源黑体有 5 个字重，而一张图通常只用 2 个，筛掉就省 60%。
 *
 * 与图片内嵌（`assets.ts`）同构：纯函数负责「选哪些」，异步负责「抓字节」，
 * 中间用一张映射表接起来，这样改一次导出选项不必重新下载一遍字体。
 */

import type { FontFamily } from '../model/types';
import { FONT_DEFINITIONS } from '../theme/fonts';
import type { ExportContext } from './context';
import { paintedRuns } from './fonts';

/** 一个 `@font-face` 声明里我们需要的那几项。 */
export interface FontFace {
  family: string;
  weight: string;
  style: string;
  /** 分片地址，同时也是去重键。 */
  url: string;
  /** 原样保留的 `unicode-range` 片段，写回时不能重新格式化（会丢 `?` 通配）。 */
  ranges: string[];
  /** 已解析的区间，用于匹配码位。 */
  spans: [number, number][];
}

/** 一条 `U+4E00-9FFF` / `U+4E??` / `U+3002` 形式的声明。 */
export function parseRangeSpec(spec: string): [number, number] | null {
  const body = spec.trim().replace(/^U\+/i, '');
  if (body === '') return null;

  if (body.includes('?')) {
    // 通配写法：`4E??` 等价于 `4E00-4EFF`。不展开它就会静默漏掉一整片覆盖，
    // 表现是「明明有字形却报缺字」。
    const low = Number.parseInt(body.replace(/\?/g, '0'), 16);
    const high = Number.parseInt(body.replace(/\?/g, 'F'), 16);
    return Number.isFinite(low) && Number.isFinite(high) ? [low, high] : null;
  }

  const dash = body.indexOf('-');
  if (dash > 0) {
    const low = Number.parseInt(body.slice(0, dash), 16);
    const high = Number.parseInt(body.slice(dash + 1), 16);
    return Number.isFinite(low) && Number.isFinite(high) ? [low, high] : null;
  }

  const single = Number.parseInt(body, 16);
  return Number.isFinite(single) ? [single, single] : null;
}

/** 取 `@font-face { ... }` 里某个属性的值。 */
function property(body: string, name: string): string {
  const match = body.match(new RegExp(`(?:^|;|\\s)${name}\\s*:\\s*([^;]+);`));
  return match?.[1]?.trim() ?? '';
}

/**
 * 解析一份按族生成的 `@font-face` 样式表。
 *
 * 只认 `url('…')` 与 `url("…")` 两种写法——`fonts.css` 是脚本生成的，格式固定；
 * 写成正则宽容到能吞 `url(data:…)` 反而会让「已经内嵌过的表」被二次处理。
 */
export function parseFontFaces(css: string): FontFace[] {
  const faces: FontFace[] = [];
  const blocks = css.matchAll(/@font-face\s*\{([^}]*)\}/g);

  for (const block of blocks) {
    const body = block[1];
    const url = body.match(/src\s*:[^;]*url\(\s*['"]?([^'")]+)['"]?\s*\)/)?.[1] ?? '';
    if (url === '') continue;

    const rangeText = property(body, 'unicode-range');
    const ranges = rangeText
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part !== '');
    const spans: [number, number][] = [];
    for (const spec of ranges) {
      const span = parseRangeSpec(spec);
      if (span !== null) spans.push(span);
    }
    // 没有 unicode-range 的 face 覆盖全部码位；这里把它当成「全都要」，
    // 否则一个都没匹配上，反而漏嵌。
    if (spans.length === 0) spans.push([0, 0x10ffff]);

    faces.push({
      family: property(body, 'font-family').replace(/['"]/g, ''),
      weight: property(body, 'font-weight') || '400',
      style: property(body, 'font-style') || 'normal',
      url,
      ranges,
      spans,
    });
  }

  return faces;
}

function covers(face: FontFace, codePoint: number): boolean {
  for (const [low, high] of face.spans) {
    if (codePoint >= low && codePoint <= high) return true;
  }
  return false;
}

/** 一族要嵌哪些 face。 */
export interface FamilyNeed {
  family: FontFamily;
  /** 用到的字重（`@font-face` 里的数值字符串）。 */
  weights: Set<string>;
  /** 用到的码位。 */
  codePoints: Set<number>;
}

/**
 * 按「族 + 字重 + 码位」算出需要哪些 face。
 *
 * 字重来自每个节点的计算样式，缺失时按 400 算——与 `@font-face` 的默认值一致。
 * 用不到的字重不嵌：思源黑体 5 个字重 × 102 片，全嵌是 4.5 MB。
 */
export function planFamilies(ctx: ExportContext): FamilyNeed[] {
  const needs = new Map<FontFamily, FamilyNeed>();

  for (const run of paintedRuns(ctx)) {
    if (run.text === '') continue;
    // `system` 不随包分发，没有 face 可嵌。
    if (FONT_DEFINITIONS[run.family].cssPath === null) continue;

    let need = needs.get(run.family);
    if (need === undefined) {
      need = { family: run.family, weights: new Set(), codePoints: new Set() };
      needs.set(run.family, need);
    }
    need.weights.add(String(run.weight));
    for (const char of run.text) {
      const cp = char.codePointAt(0);
      if (cp !== undefined && cp > 0x20) need.codePoints.add(cp);
    }
  }

  return [...needs.values()];
}

/**
 * 从一族的全部 face 里挑出真正要内嵌的那些。
 *
 * 去重按 url：同一片在不同 `@font-face` 里不会重复出现，但同一条 CSS 被解析
 * 两次（sans 与 serif 各自的表里都有 latin 分片）时会出现同一个地址。
 */
export function pickFaces(faces: readonly FontFace[], need: FamilyNeed): FontFace[] {
  const out: FontFace[] = [];
  const seen = new Set<string>();

  for (const face of faces) {
    if (!need.weights.has(face.weight)) continue;
    if (seen.has(face.url)) continue;

    let hit = false;
    for (const cp of need.codePoints) {
      if (covers(face, cp)) {
        hit = true;
        break;
      }
    }
    if (!hit) continue;

    seen.add(face.url);
    out.push(face);
  }

  return out;
}

/** 生成要写进 SVG 的 `<style>` 内容。`data` 里缺的地址按原地址写回（不该发生）。 */
export function buildFontCss(
  faces: readonly FontFace[],
  data: ReadonlyMap<string, string>,
): string {
  const rules: string[] = [];
  for (const face of faces) {
    const src = data.get(face.url);
    if (src === undefined) continue;
    rules.push(
      [
        '@font-face {',
        `font-family: '${face.family}';`,
        `font-style: ${face.style};`,
        `font-weight: ${face.weight};`,
        `font-display: block;`,
        `src: url('${src}') format('woff2');`,
        face.ranges.length === 0 ? '' : `unicode-range: ${face.ranges.join(', ')};`,
        '}',
      ]
        .filter((line) => line !== '')
        .join(' '),
    );
  }
  return rules.join('\n');
}

/** 抓字节的依赖，注入是为了能在 node 里测「选片逻辑」而不碰网络。 */
export interface FontEmbedDeps {
  /** 读一份样式表。 */
  fetchText(url: string): Promise<string | null>;
  /** 把一个分片读成 `data:` URL。 */
  fetchDataUrl(url: string): Promise<string | null>;
}

/** 分片字节的模块级缓存：同一次会话里导出多张图不必重下一遍。 */
const dataUrlCache = new Map<string, string>();
const cssCache = new Map<string, FontFace[]>();

/** 测试用：清掉模块级缓存。 */
export function resetFontCache(): void {
  dataUrlCache.clear();
  cssCache.clear();
}

const FETCH_TIMEOUT_MS = 15000;

async function fetchOk(url: string): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return response.ok ? response : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 浏览器默认实现。抓不到就返回 null，调用方降级为「不嵌这一片」。 */
export const browserFontDeps: FontEmbedDeps = {
  async fetchText(url) {
    const response = await fetchOk(url);
    return response === null ? null : response.text();
  },
  async fetchDataUrl(url) {
    const cached = dataUrlCache.get(url);
    if (cached !== undefined) return cached;
    const response = await fetchOk(url);
    if (response === null) return null;
    const blob = await response.blob();
    const dataUrl = await new Promise<string | null>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
    if (dataUrl !== null) dataUrlCache.set(url, dataUrl);
    return dataUrl;
  },
};

export interface FontEmbedResult {
  /** 写进 `<style>` 的内容，没有可嵌的东西时为空串。 */
  css: string;
  /** 实际内嵌的字节数（base64 之前的估算），用于提示体积。 */
  faces: number;
}

/**
 * 把这份导出上下文要用的字体读成一段可直接内联的 CSS。
 *
 * 串行抓取而不是 `Promise.all`：一次最多十几片、每片几十 KB，并发的好处抵不上
 * 峰值内存翻倍的风险——而这一步本来就在「点下载之后」。
 */
export async function loadFontCss(
  ctx: ExportContext,
  deps: FontEmbedDeps = browserFontDeps,
): Promise<FontEmbedResult> {
  const needs = planFamilies(ctx);
  if (needs.length === 0) return { css: '', faces: 0 };

  const allFaces: FontFace[] = [];
  for (const need of needs) {
    const path = FONT_DEFINITIONS[need.family].cssPath;
    if (path === null) continue;

    let faces = cssCache.get(path);
    if (faces === undefined) {
      const text = await deps.fetchText(path);
      if (text === null) continue;
      faces = parseFontFaces(text);
      cssCache.set(path, faces);
    }
    allFaces.push(...pickFaces(faces, need));
  }

  if (allFaces.length === 0) return { css: '', faces: 0 };

  const data = new Map<string, string>();
  for (const face of allFaces) {
    const url = await deps.fetchDataUrl(face.url);
    if (url !== null) data.set(face.url, url);
  }

  return { css: buildFontCss(allFaces, data), faces: data.size };
}

/** 把 CSS 挂到上下文上。空串时返回原对象（`useMemo` 依赖它）。 */
export function applyFontCss(ctx: ExportContext, css: string): ExportContext {
  if (css === '' || css === ctx.fontCss) return ctx;
  return { ...ctx, fontCss: css };
}
