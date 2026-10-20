/**
 * 适配器运行时环境的测试。
 *
 * 这里守的是「所有适配器共用一套上限」这件事：只要 `topic()` 与 `title()`
 * 的行为是对的，将来新增格式就没法绕过节点上限与标题长度。
 */

import { describe, expect, it } from 'vitest';
import { createImportContext } from './context';
import { ImportError } from './errors';
import { IMPORT_LIMITS, resolveLimits } from './limits';

function makeContext(overrides: Partial<typeof IMPORT_LIMITS> = {}) {
  return createImportContext({
    fileName: 'sample.xmind',
    limits: resolveLimits(overrides),
  });
}

describe('topic 计数', () => {
  it('累计到上限为止', () => {
    const handle = makeContext({ maxTopics: 3 });
    handle.context.topic();
    handle.context.topic();
    handle.context.topic();
    expect(handle.topicCount()).toBe(3);
  });

  it('超过上限抛 TOO_MANY_TOPICS 而不是静默截断', () => {
    const handle = makeContext({ maxTopics: 2 });
    handle.context.topic();
    handle.context.topic();
    try {
      handle.context.topic();
      throw new Error('预期抛错');
    } catch (error) {
      expect(error).toBeInstanceOf(ImportError);
      // 截断会产出一份「看起来正常、实际少一半」的文档，用户保存即永久丢失。
      expect((error as ImportError).code).toBe('TOO_MANY_TOPICS');
      // 「个」类上限用 `max`，`limit` 专指字节数（见 format.ts 的白名单）。
      expect((error as ImportError).params.max).toBe(2);
    }
  });
});

describe('title 清洗与截断', () => {
  it('删掉控制字符但保留换行与制表', () => {
    const { context } = makeContext();
    expect(context.title('a\u0000b\u0007c')).toBe('abc');
    expect(context.title('第一行\n第二行\t结束')).toBe('第一行\n第二行\t结束');
  });

  it('超长标题按上限截断并计数', () => {
    const handle = makeContext({ maxTitleLength: 5 });
    expect(handle.context.title('一二三四五六七')).toBe('一二三四五');
    expect(handle.truncatedTitles()).toBe(1);
    // 没超长的不计数
    handle.context.title('短');
    expect(handle.truncatedTitles()).toBe(1);
  });

  it('截断不会把代理对劈成半个', () => {
    // emoji 是 2 个 UTF-16 码元。上限 3 时，'ab' + emoji 的第 4 个码元
    // 会把 emoji 切成孤立高位代理，渲染成方块。
    const handle = makeContext({ maxTitleLength: 3 });
    expect(handle.context.title('ab😀')).toBe('ab');
  });
});

describe('warn 去重', () => {
  it('同 code 同参数只留一条', () => {
    const handle = makeContext();
    handle.context.warn('font-normalized', { from: '楷体', to: 'serif' });
    handle.context.warn('font-normalized', { from: '楷体', to: 'serif' });
    handle.context.warn('font-normalized', { from: '楷体', to: 'serif' });
    expect(handle.warnings).toHaveLength(1);
  });

  it('参数不同视为不同警告', () => {
    const handle = makeContext();
    handle.context.warn('font-normalized', { from: '楷体', to: 'serif' });
    handle.context.warn('font-normalized', { from: 'Consolas', to: 'mono' });
    expect(handle.warnings).toHaveLength(2);
  });

  it('无参数警告按 code 去重', () => {
    const handle = makeContext();
    handle.context.warn('palette-fallback');
    handle.context.warn('palette-fallback');
    expect(handle.warnings).toEqual([{ code: 'palette-fallback' }]);
  });
});

describe('unsupported 计数', () => {
  it('同一特性累加，默认一次计 1', () => {
    const handle = makeContext();
    handle.context.unsupported('sticker');
    handle.context.unsupported('sticker');
    handle.context.unsupported('audio', 3);
    expect(handle.unsupported).toEqual({ sticker: 2, audio: 3 });
  });

  it('0 与负数不产生条目', () => {
    const handle = makeContext();
    handle.context.unsupported('gantt', 0);
    handle.context.unsupported('gantt', -2);
    expect(handle.unsupported).toEqual({});
  });
});

describe('图片登记', () => {
  const asset = (ref: string) => ({
    ref,
    bytes: new Uint8Array([1]),
    fileName: ref.replace('xap:', ''),
    mime: 'image/png',
  });

  it('按 ref 去重，同一个条目只传一次', () => {
    const handle = makeContext();
    expect(handle.context.asset(asset('xap:resources/a.png'))).toBe(true);
    // 复制粘贴出来的节点共用同一个资源条目。
    expect(handle.context.asset(asset('xap:resources/a.png'))).toBe(true);
    expect(handle.assets).toHaveLength(1);
  });

  it('超过 maxAssets 返回 false，且不入队', () => {
    const handle = makeContext({ maxAssets: 1 });
    expect(handle.context.asset(asset('xap:resources/a.png'))).toBe(true);
    // 返回 false 是让适配器把这张图算进「未能还原」，而不是写一个没人认领的占位符。
    expect(handle.context.asset(asset('xap:resources/b.png'))).toBe(false);
    expect(handle.assets.map((item) => item.ref)).toEqual(['xap:resources/a.png']);
  });
});

describe('ID 工厂', () => {
  it('默认生成带前缀的唯一 ID', () => {
    const { context } = makeContext();
    expect(context.ids.topic()).toMatch(/^tp-[0-9A-Z]{26}$/);
    expect(context.ids.sheet()).toMatch(/^sh-[0-9A-Z]{26}$/);
    expect(context.ids.relationship()).toMatch(/^rel-/);
    expect(context.ids.boundary()).toMatch(/^bnd-/);
    expect(context.ids.summary()).toMatch(/^sum-/);
    expect(context.ids.document()).toMatch(/^[0-9A-Z]{26}$/);
  });

  it('可以注入确定性实现（测试用）', () => {
    let n = 0;
    const handle = createImportContext({
      fileName: 'x',
      limits: resolveLimits(),
      ids: {
        document: () => 'doc-1',
        sheet: () => 'sheet-1',
        topic: () => `t-${(n += 1)}`,
        relationship: () => 'rel-1',
        boundary: () => 'bnd-1',
        summary: () => 'sum-1',
      },
    });
    expect(handle.context.ids.topic()).toBe('t-1');
    expect(handle.context.ids.topic()).toBe('t-2');
    expect(handle.context.ids.document()).toBe('doc-1');
  });
});
