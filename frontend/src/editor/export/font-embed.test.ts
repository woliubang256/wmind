/**
 * 字体内嵌的测试。
 *
 * 三件事必须对：
 *
 * 1. **选片准**。选多了体积爆掉（505 片全嵌 4.5 MB），选少了缺字。
 * 2. **通配写法要展开**。`U+4E??` 漏解析就等于漏掉一整片覆盖，而症状是
 *    「嵌了字体却还是回退」——最难查的那种。
 * 3. **不改写 `unicode-range`**。原样写回，否则浏览器按错的区间挑 face。
 */

import { describe, expect, it } from 'vitest';
import { createDocument, createSheet, createTopic } from '../model/create';
import type { Sheet, WmindDocument } from '../model/types';
import { DEFAULT_EXPORT_OPTIONS, buildExportContext } from './context';
import {
  applyFontCss,
  buildFontCss,
  loadFontCss,
  parseFontFaces,
  parseRangeSpec,
  pickFaces,
  planFamilies,
  resetFontCache,
  type FontEmbedDeps,
} from './font-embed';
import { buildExportSvg } from './svg';

/** 造一条 `@font-face`，与 `scripts/fetch-fonts.mjs` 生成的形状一致。 */
function faceRule(url: string, weight: number, range: string, quote = "'"): string {
  return `@font-face {
  font-family: 'Noto Sans SC';
  font-style: normal;
  font-weight: ${weight};
  font-display: block;
  src: url(${quote}${url}${quote}) format('woff2');
  unicode-range: ${range};
}`;
}

/**
 * 一份贴近真实的样式表：每个字重一片 CJK 主片，外加标点、通配片、拉丁片。
 *
 * 字重覆盖 300/400/600/700/800 是必需的——`planFamilies` 的字重来自节点的
 * 计算样式，根节点是 800、子节点是 400，夹具里缺哪个都会让「选片」测不出东西。
 */
const CSS = [
  ...[300, 400, 600, 700, 800].map((weight) => faceRule(`/fonts/sans/cjk-${weight}.woff2`, weight, 'U+4E00-9FFF')),
  faceRule('/fonts/sans/punct-400.woff2', 400, 'U+3002'),
  faceRule('/fonts/sans/hex-400.woff2', 400, 'U+4E??', '"'),
  faceRule('/fonts/sans/latin-400.woff2', 400, 'U+0041-005A'),
].join('\n');

const CJK_WEIGHT_400 = '/fonts/sans/cjk-400.woff2';

function sheetWith(titles: string[]): Sheet {
  const sheet = createSheet({ id: 'sheet-0', title: '画布 0' });
  sheet.rootTopic = createTopic({ id: 'root', title: '根' });
  titles.forEach((title, index) => {
    sheet.rootTopic.children.attached.push(createTopic({ id: `t-${index}`, title }));
  });
  return sheet;
}

function ctxOf(sheet: Sheet, document?: Partial<WmindDocument>) {
  const doc = createDocument({ title: '测试' });
  doc.sheets = [sheet];
  Object.assign(doc, document);
  return buildExportContext(doc, 'sheet-0', { ...DEFAULT_EXPORT_OPTIONS, brand: false });
}

describe('parseRangeSpec', () => {
  it('单个码位', () => {
    expect(parseRangeSpec('U+3002')).toEqual([0x3002, 0x3002]);
  });

  it('区间', () => {
    expect(parseRangeSpec('U+4E00-9FFF')).toEqual([0x4e00, 0x9fff]);
  });

  it('通配写法展开成区间', () => {
    expect(parseRangeSpec('U+4E??')).toEqual([0x4e00, 0x4eff]);
    expect(parseRangeSpec('U+4???')).toEqual([0x4000, 0x4fff]);
  });

  it('大小写与前缀都认', () => {
    expect(parseRangeSpec('u+4e00-9fff')).toEqual([0x4e00, 0x9fff]);
  });

  it('空串与垃圾返回 null', () => {
    expect(parseRangeSpec('')).toBeNull();
    expect(parseRangeSpec('U+')).toBeNull();
    expect(parseRangeSpec('U+zzzz')).toBeNull();
  });
});

describe('parseFontFaces', () => {
  it('逐条读出族、字重、地址与区间', () => {
    const faces = parseFontFaces(CSS);
    expect(faces).toHaveLength(8);
    expect(faces[0]).toMatchObject({
      family: 'Noto Sans SC',
      weight: '300',
      url: '/fonts/sans/cjk-300.woff2',
      ranges: ['U+4E00-9FFF'],
    });
  });

  it('双引号写法也认', () => {
    expect(parseFontFaces(CSS).find((face) => face.url.includes('hex'))?.url).toBe(
      '/fonts/sans/hex-400.woff2',
    );
  });

  it('区间原样保留（不重新格式化）', () => {
    expect(parseFontFaces(CSS).find((face) => face.url.includes('hex'))?.ranges).toEqual(['U+4E??']);
  });

  it('多段 unicode-range 全保留', () => {
    const faces = parseFontFaces(faceRule('/a.woff2', 400, 'U+4E00-9FFF, U+3002'));
    expect(faces[0]?.ranges).toEqual(['U+4E00-9FFF', 'U+3002']);
  });

  it('没有 src 的块被跳过', () => {
    expect(parseFontFaces('@font-face { font-family: X; font-weight: 400; }')).toEqual([]);
  });

  it('没有 unicode-range 的 face 视为覆盖全部', () => {
    const face = parseFontFaces('@font-face { font-family: X; src: url(/a.woff2); }')[0]!;
    expect(face.spans).toEqual([[0, 0x10ffff]]);
  });
});

describe('pickFaces', () => {
  const faces = parseFontFaces(CSS);

  it('按码位挑片', () => {
    const picked = pickFaces(faces, { family: 'sans', weights: new Set(['400']), codePoints: new Set([0x3002]) });
    expect(picked.map((face) => face.url)).toEqual(['/fonts/sans/punct-400.woff2']);
  });

  it('通配片也能命中', () => {
    const picked = pickFaces(faces, { family: 'sans', weights: new Set(['400']), codePoints: new Set([0x4e01]) });
    expect(picked.map((face) => face.url).sort()).toEqual([
      '/fonts/sans/cjk-400.woff2',
      '/fonts/sans/hex-400.woff2',
    ]);
  });

  it('用不到的字重不嵌', () => {
    const picked = pickFaces(faces, { family: 'sans', weights: new Set(['700']), codePoints: new Set([0x4e00]) });
    expect(picked.map((face) => face.url)).toEqual(['/fonts/sans/cjk-700.woff2']);
  });

  it.each([
    { requested: 500, available: [300, 400, 600], matched: 400 },
    { requested: 400, available: [300, 500, 600], matched: 500 },
    { requested: 450, available: [400, 500, 600], matched: 500 },
    { requested: 450, available: [300, 400, 600], matched: 400 },
    { requested: 350, available: [300, 400], matched: 300 },
    { requested: 200, available: [300, 400], matched: 300 },
    { requested: 650, available: [400, 600, 700], matched: 700 },
    { requested: 900, available: [400, 700, 800], matched: 800 },
    { requested: 500, available: [600, 700], matched: 600 },
    { requested: 500, available: [100, 300, 700], matched: 300 },
    { requested: 700, available: [300, 400, 700, 800], matched: 700 },
  ])('请求 $requested 时在 $available 中按 CSS 规则选 $matched', ({ requested, available, matched }) => {
    const candidates = parseFontFaces(available.map((weight) => faceRule(`/weight-${weight}.woff2`, weight, 'U+4E00')).join('\n'));
    const picked = pickFaces(candidates, { family: 'sans', weights: new Set([String(requested)]), codePoints: new Set([0x4e00]) });
    expect(picked.map((face) => face.url)).toEqual([`/weight-${matched}.woff2`]);
  });

  it('回退字重后仍只取命中码位的分片，多个请求命中同一字重不重复', () => {
    const picked = pickFaces(faces, { family: 'sans', weights: new Set(['400', '500']), codePoints: new Set([0x3002]) });
    expect(picked.map((face) => face.url)).toEqual(['/fonts/sans/punct-400.woff2']);
    expect(picked[0]!.weight).toBe('400');
  });

  it('先在整族匹配字重，不能因该字重缺字而改选更重的分片', () => {
    const candidates = parseFontFaces([
      faceRule('/latin-400.woff2', 400, 'U+0041'),
      faceRule('/cjk-600.woff2', 600, 'U+4E00'),
    ].join('\n'));
    expect(pickFaces(candidates, { family: 'sans', weights: new Set(['500']), codePoints: new Set([0x4e00]) })).toEqual([]);
  });

  it('共享 URL 保留各字重和范围的声明，仅合并完全相同的声明', () => {
    const candidates = parseFontFaces([
      faceRule('/shared.woff2', 400, 'U+4E00'),
      faceRule('/shared.woff2', 400, 'U+4E00'),
      faceRule('/shared.woff2', 800, 'U+4E00'),
      faceRule('/shared.woff2', 400, 'U+3002'),
    ].join('\n'));
    const picked = pickFaces(candidates, { family: 'sans', weights: new Set(['400', '800']), codePoints: new Set([0x4e00, 0x3002]) });
    expect(picked.map((face) => [face.weight, face.ranges])).toEqual([
      ['400', ['U+4E00']],
      ['800', ['U+4E00']],
      ['400', ['U+3002']],
    ]);
  });

  it('码位不在任何片里时返回空', () => {
    expect(pickFaces(faces, { family: 'sans', weights: new Set(['400']), codePoints: new Set([0x1f600]) })).toEqual([]);
  });
});

describe('planFamilies', () => {
  it('只收随包分发的族', () => {
    // 根节点也要改成 system：它默认是 sans，只改子节点等于什么都没改。
    const sheet = sheetWith(['系统字体']);
    sheet.rootTopic.style = { fontFamily: 'system' };
    sheet.rootTopic.children.attached[0]!.style = { fontFamily: 'system' };
    expect(planFamilies(ctxOf(sheet))).toEqual([]);
  });

  it('族、字重、码位都算进去', () => {
    const sheet = sheetWith(['Ab']);
    const need = planFamilies(ctxOf(sheet));
    const sans = need.find((item) => item.family === 'sans')!;
    expect(sans.codePoints.has('A'.codePointAt(0)!)).toBe(true);
    // 根节点与子节点都算，字重集合里至少有一个。
    expect(sans.weights.size).toBeGreaterThan(0);
  });

  it('空白不进码位集合', () => {
    const need = planFamilies(ctxOf(sheetWith(['A B'])));
    expect(need[0]!.codePoints.has(0x20)).toBe(false);
  });
});

describe('buildFontCss', () => {
  const faces = parseFontFaces(CSS);

  it('地址换成 data: URL，区间原样写回', () => {
    const face = faces.find((item) => item.url === CJK_WEIGHT_400)!;
    const css = buildFontCss([face], new Map([[CJK_WEIGHT_400, 'data:font/woff2;base64,AAA']]));
    expect(css).toContain("src: url('data:font/woff2;base64,AAA') format('woff2')");
    expect(css).toContain('unicode-range: U+4E00-9FFF');
    expect(css).toContain("font-family: 'Noto Sans SC'");
  });

  it('拿不到字节的片被跳过（不写一条指向原地址的规则）', () => {
    expect(buildFontCss(faces.slice(0, 1), new Map())).toBe('');
  });
});

describe('loadFontCss', () => {
  function deps(): FontEmbedDeps & { textCalls: string[]; dataCalls: string[] } {
    const textCalls: string[] = [];
    const dataCalls: string[] = [];
    return {
      textCalls,
      dataCalls,
      async fetchText(url) {
        textCalls.push(url);
        return url === '/fonts/sans.css' ? CSS : null;
      },
      async fetchDataUrl(url) {
        dataCalls.push(url);
        return `data:font/woff2;base64,${url}`;
      },
    };
  }

  it('把用到的片拼成一段 @font-face', async () => {
    resetFontCache();
    const spy = deps();
    const result = await loadFontCss(ctxOf(sheetWith(['汉字'])), spy);
    expect(result.css).toContain('@font-face');
    expect(result.css).toContain('data:font/woff2;base64,/fonts/sans/cjk-');
    expect(spy.textCalls).toEqual(['/fonts/sans.css']);
    expect(result.faces).toBeGreaterThan(0);
  });

  it('仅概要使用 sans 500 时内嵌 400 分片并保留概要渲染字重', async () => {
    resetFontCache();
    const sheet = sheetWith(['系统字体']);
    sheet.rootTopic.style = { fontFamily: 'system' };
    sheet.rootTopic.children.attached[0]!.style = { fontFamily: 'system' };
    sheet.summaries.push({ id: 'summary', topicId: 'root', range: ['t-0'], title: '概要', style: null });
    const ctx = ctxOf(sheet);
    expect(ctx.brand).toBe(false);
    expect(ctx.date).toBeNull();
    expect(planFamilies(ctx).map((need) => [need.family, [...need.weights]])).toEqual([['sans', ['500']]]);
    const spy = deps();
    const result = await loadFontCss(ctx, spy);
    expect(spy.dataCalls).toEqual([CJK_WEIGHT_400]);
    expect(result.faces).toBe(1);
    expect(result.css).toContain('font-weight: 400;');
    expect(result.css).not.toContain('font-weight: 600;');
    expect(buildExportSvg(applyFontCss(ctx, result.css))).toMatch(/<text\b[^>]*font-weight:500[^>]*>概要<\/text>/);
  });

  it('共享 URL 的多个字重只读一次字节，内嵌时保留各条声明', async () => {
    resetFontCache();
    const sheet = sheetWith(['正文']);
    sheet.rootTopic.style = { fontFamily: 'sans', fontWeight: 800 };
    sheet.rootTopic.children.attached[0]!.style = { fontFamily: 'sans', fontWeight: 400 };
    const dataCalls: string[] = [];
    const result = await loadFontCss(ctxOf(sheet), {
      async fetchText() {
        return [faceRule('/shared.woff2', 400, 'U+4E00-9FFF'), faceRule('/shared.woff2', 800, 'U+4E00-9FFF')].join('\n');
      },
      async fetchDataUrl(url) { dataCalls.push(url); return 'data:font/woff2;base64,AAA'; },
    });
    expect(dataCalls).toEqual(['/shared.woff2']);
    expect(result.faces).toBe(1);
    const embedded = parseFontFaces(result.css);
    expect(embedded.map((face) => face.weight)).toEqual(['400', '800']);
    expect(embedded.every((face) => face.url === 'data:font/woff2;base64,AAA')).toBe(true);
  });

  it('同一个族只读一次样式表（模块级缓存）', async () => {
    resetFontCache();
    const spy = deps();
    await loadFontCss(ctxOf(sheetWith(['汉字'])), spy);
    await loadFontCss(ctxOf(sheetWith(['别的字'])), spy);
    expect(spy.textCalls).toEqual(['/fonts/sans.css']);
  });

  it('样式表读不到时降级为「不嵌」，不抛', async () => {
    resetFontCache();
    const result = await loadFontCss(ctxOf(sheetWith(['汉字'])), {
      async fetchText() {
        return null;
      },
      async fetchDataUrl() {
        return 'data:x';
      },
    });
    expect(result).toEqual({ css: '', faces: 0 });
  });

  it('没有可嵌的族时直接返回空', async () => {
    resetFontCache();
    const sheet = sheetWith(['x']);
    sheet.rootTopic.style = { fontFamily: 'system' };
    sheet.rootTopic.children.attached[0]!.style = { fontFamily: 'system' };
    const spy = deps();
    expect(await loadFontCss(ctxOf(sheet), spy)).toEqual({ css: '', faces: 0 });
    expect(spy.textCalls).toEqual([]);
  });
});

describe('applyFontCss', () => {
  it('挂上 CSS', () => {
    const ctx = ctxOf(sheetWith(['汉字']));
    expect(applyFontCss(ctx, 'x').fontCss).toBe('x');
  });

  it('空串或没变化时返回原对象（useMemo 依赖它）', () => {
    const ctx = ctxOf(sheetWith(['汉字']));
    expect(applyFontCss(ctx, '')).toBe(ctx);
    expect(applyFontCss({ ...ctx, fontCss: 'x' }, 'x').fontCss).toBe('x');
  });
});

describe('写进 SVG', () => {
  it('有 CSS 时出现 <defs><style>，没有时不出现', () => {
    const ctx = ctxOf(sheetWith(['汉字']));
    expect(buildExportSvg(ctx)).not.toContain('<defs>');
    const withFonts = applyFontCss(ctx, "@font-face { font-family: 'Noto Sans SC'; }");
    const markup = buildExportSvg(withFonts);
    expect(markup).toContain('<defs>');
    expect(markup).toContain('Noto Sans SC');
  });
});
