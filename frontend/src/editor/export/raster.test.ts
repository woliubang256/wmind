/**
 * 栅格化的测试。
 *
 * 尺寸闸门与格式参数是纯函数，直接断言；`rasterizeSvg` 通过注入依赖验证
 * 「谁被调用、按什么顺序、参数对不对」——这几件事在浏览器里肉眼看不出来，
 * 但错了就会得到一张白图或者一张黑底的 JPEG。
 */

import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_EXPORT_OPTIONS, buildExportContext } from './context';
import { createDocument, createSheet, createTopic } from '../model/create';
import {
  RASTER_LIMITS,
  checkRasterSize,
  rasterPlan,
  rasterizeSvg,
  type RasterDeps,
} from './raster';

const opts = (patch: Partial<typeof DEFAULT_EXPORT_OPTIONS> = {}) => ({
  ...DEFAULT_EXPORT_OPTIONS,
  ...patch,
});

describe('尺寸闸门', () => {
  it('小图直接放行', () => {
    expect(checkRasterSize(1200, 800)).toEqual({ kind: 'ok' });
  });

  it('单边超过 8192 但没到 16384：警告但允许', () => {
    expect(checkRasterSize(9000, 1000)).toEqual({ kind: 'warn' });
  });

  it('单边超过 16384：拦住并报出实际边长', () => {
    expect(checkRasterSize(20000, 1000)).toEqual({
      kind: 'too-large',
      side: 20000,
      limit: RASTER_LIMITS.maxSide,
    });
  });

  it('总像素超限也算太大（两边都不超单边上限时仍可能撞内存）', () => {
    // 16000² = 256M，还在 268M 以内，只是「有点大」。
    expect(checkRasterSize(16000, 16000).kind).toBe('warn');
    // 16384² = 268.4M，正好越过总像素上限；单边没有超，但内存撑不住。
    expect(checkRasterSize(16384, 16384).kind).toBe('too-large');
  });

  it('尺寸算不出来时按太大处理，不拿 0×0 去撞 canvas', () => {
    expect(checkRasterSize(0, 100).kind).toBe('too-large');
    expect(checkRasterSize(Number.NaN, 100).kind).toBe('too-large');
  });

  it('刚好在边界上：16384 放行（警告级），16385 拦住', () => {
    expect(checkRasterSize(16384, 1).kind).toBe('warn');
    expect(checkRasterSize(16385, 1).kind).toBe('too-large');
  });
});

describe('格式参数', () => {
  it('JPEG 一定有不透明底色', () => {
    expect(rasterPlan('jpeg', null).fill).toBe('#FFFFFF');
    expect(rasterPlan('jpeg', '#FAFAFA').fill).toBe('#FAFAFA');
    expect(rasterPlan('jpeg', null).mime).toBe('image/jpeg');
  });

  it('PNG 透明时不铺底色', () => {
    expect(rasterPlan('png', null)).toEqual({ mime: 'image/png', quality: 1, fill: null });
  });

  it('PNG 不透明时按主题底色铺', () => {
    expect(rasterPlan('png', '#123456').fill).toBe('#123456');
  });
});

describe('上下文里的 JPEG 背景', () => {
  function doc() {
    const document = createDocument({ title: 'jpeg' });
    const sheet = createSheet({ id: 'sheet-0', title: '画布 0' });
    sheet.rootTopic = createTopic({ id: 'root-0', title: '根' });
    document.sheets = [sheet];
    return document;
  }

  it('JPEG + 透明背景 → 上下文里就是白色（预览即成品）', () => {
    const ctx = buildExportContext(doc(), 'sheet-0', opts({ format: 'jpeg', transparent: true }));
    expect(ctx.background).toBe('#FFFFFF');
  });

  it('PNG + 透明背景 → 仍然是透明', () => {
    const ctx = buildExportContext(doc(), 'sheet-0', opts({ format: 'png', transparent: true }));
    expect(ctx.background).toBeNull();
  });

  it('JPEG 不透明时用主题底色', () => {
    const document = doc();
    const ctx = buildExportContext(document, 'sheet-0', opts({ format: 'jpeg' }));
    expect(ctx.background).toBe(document.theme.palette.backgroundColor);
  });
});

function fakeDeps(overrides: Partial<RasterDeps> = {}) {
  const calls: string[] = [];
  const context = {
    fillStyle: '',
    fillRect: vi.fn(() => { calls.push('fill'); }),
    drawImage: vi.fn(() => { calls.push('draw'); }),
  };
  const deps: RasterDeps = {
    loadImage: vi.fn(async () => ({ width: 10, height: 10 })),
    createCanvas: vi.fn(() => ({ getContext: () => context })),
    toBlob: vi.fn(async () => new Blob(['x'], { type: 'image/png' })),
    createObjectUrl: vi.fn(() => 'blob:fake'),
    revokeObjectUrl: vi.fn(),
    ...overrides,
  };
  return { deps, context, calls };
}

describe('栅格化', () => {
  it('先铺底色再画图（顺序反了会被图盖住）', async () => {
    const { deps, calls } = fakeDeps();
    await rasterizeSvg('<svg/>', { width: 100, height: 50, format: 'png', background: '#FFFFFF' }, deps);
    expect(calls).toEqual(['fill', 'draw']);
  });

  it('PNG 透明时不铺底色', async () => {
    const { deps, calls } = fakeDeps();
    await rasterizeSvg('<svg/>', { width: 10, height: 10, format: 'png', background: null }, deps);
    expect(calls).toEqual(['draw']);
  });

  it('按目标尺寸建画布，而不是用图片的自然尺寸', async () => {
    const { deps } = fakeDeps();
    await rasterizeSvg('<svg/>', { width: 800, height: 600, format: 'png', background: null }, deps);
    expect(deps.createCanvas).toHaveBeenCalledWith(800, 600);
  });

  it('JPEG 传 image/jpeg 与质量参数', async () => {
    const { deps } = fakeDeps();
    await rasterizeSvg('<svg/>', { width: 10, height: 10, format: 'jpeg', background: '#FFFFFF' }, deps);
    expect(deps.toBlob).toHaveBeenCalledWith(expect.anything(), 'image/jpeg', 0.92);
  });

  it('无论成败都撤销 objectURL', async () => {
    const { deps } = fakeDeps({ loadImage: vi.fn(async () => { throw new Error('坏了'); }) });
    await expect(
      rasterizeSvg('<svg/>', { width: 10, height: 10, format: 'png', background: null }, deps),
    ).rejects.toThrow('坏了');
    expect(deps.revokeObjectUrl).toHaveBeenCalledWith('blob:fake');
  });

  it('toBlob 返回 null 时报错，而不是悄悄给个空文件', async () => {
    const { deps } = fakeDeps({ toBlob: vi.fn(async () => null) });
    await expect(
      rasterizeSvg('<svg/>', { width: 10, height: 10, format: 'png', background: null }, deps),
    ).rejects.toThrow('位图编码失败');
  });
});
