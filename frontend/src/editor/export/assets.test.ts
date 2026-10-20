/**
 * 图片内嵌的测试。
 *
 * 全程注入假 fetcher——`loadImageSources` 的默认实现要 `fetch` + `FileReader`，
 * 而 vitest 跑在 node 环境（没有 DOM）。这也正是把它做成注入参数的原因：
 * 「哪些地址会被抓、失败怎么处理、缓存有没有生效」都不需要浏览器就能验。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDocument, createSheet, createTopic } from '../model/create';
import type { TopicImage, WmindDocument } from '../model/types';
import { DEFAULT_EXPORT_OPTIONS, buildExportContext } from './context';
import {
  applyImageSources,
  collectImageSources,
  loadImageSources,
  resetImageCache,
  type ImageFetcher,
} from './assets';

const opts = (patch: Partial<typeof DEFAULT_EXPORT_OPTIONS> = {}) => ({
  ...DEFAULT_EXPORT_OPTIONS,
  ...patch,
});

function docWithImages(images: (TopicImage | null)[]): WmindDocument {
  const doc = createDocument({ title: '图片导出' });
  const sheet = createSheet({ id: 'sheet-0', title: '画布 0' });
  sheet.rootTopic = createTopic({ id: 'root-0', title: '根' });
  images.forEach((image, index) => {
    const topic = createTopic({ id: `c-${index}`, title: `分支 ${index}` });
    if (image !== null) topic.image = image;
    sheet.rootTopic.children.attached.push(topic);
  });
  doc.sheets = [sheet];
  return doc;
}

const PNG = 'data:image/png;base64,AAAA';

beforeEach(() => {
  resetImageCache();
});

describe('收集地址', () => {
  it('跳过 data: 与空地址，去重后保持顺序', () => {
    const doc = docWithImages([
      { src: '/uploads/a.png', width: 120, height: 80 },
      { src: '/uploads/a.png', width: 120, height: 80 },
      { src: 'https://example.com/b.png', width: 120, height: 80 },
      { src: PNG, width: 120, height: 80 },
      null,
    ]);
    const ctx = buildExportContext(doc, 'sheet-0', opts());
    expect(collectImageSources(ctx)).toEqual(['/uploads/a.png', 'https://example.com/b.png']);
  });

  it('没有图片时返回空数组', () => {
    const ctx = buildExportContext(docWithImages([null]), 'sheet-0', opts());
    expect(collectImageSources(ctx)).toEqual([]);
  });
});

describe('抓取', () => {
  it('成功的写进映射表', async () => {
    const fetcher = vi.fn<ImageFetcher>(async () => PNG);
    const map = await loadImageSources(['/uploads/a.png'], fetcher);
    expect(map.get('/uploads/a.png')).toBe(PNG);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('失败的地址不写进表（调用方会保留原 src）', async () => {
    const fetcher = vi.fn<ImageFetcher>(async () => null);
    const map = await loadImageSources(['/uploads/a.png'], fetcher);
    expect(map.size).toBe(0);
  });

  it('同一地址第二次直接命中缓存，不再抓', async () => {
    const fetcher = vi.fn<ImageFetcher>(async () => PNG);
    await loadImageSources(['/uploads/a.png'], fetcher);
    await loadImageSources(['/uploads/a.png'], fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('失败也会被记住，不会每次重算都再撞一次 404', async () => {
    const fetcher = vi.fn<ImageFetcher>(async () => null);
    await loadImageSources(['/uploads/gone.png'], fetcher);
    await loadImageSources(['/uploads/gone.png'], fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('一张失败不影响其余图片', async () => {
    const fetcher = vi.fn<ImageFetcher>(async (src) => (src.includes('bad') ? null : PNG));
    const map = await loadImageSources(['/uploads/bad.png', '/uploads/ok.png'], fetcher);
    expect([...map.keys()]).toEqual(['/uploads/ok.png']);
  });

  it('并发抓取：一张挂住不会拖住其它图片的结果', async () => {
    // 慢图永远不 resolve，模拟挂死的外链；快图必须已经进了映射表。
    let releaseSlow: (() => void) | null = null;
    const fetcher = vi.fn<ImageFetcher>((src) => {
      if (src.includes('slow')) {
        return new Promise<string | null>((resolve) => {
          releaseSlow = () => resolve(null);
        });
      }
      return Promise.resolve(PNG);
    });

    const pending = loadImageSources(['/uploads/slow.png', '/uploads/fast.png'], fetcher);
    // 让快图那一支先跑完；串行实现此时还没开始抓快图。
    await Promise.resolve();
    await Promise.resolve();
    expect(fetcher).toHaveBeenCalledTimes(2);

    releaseSlow!();
    const map = await pending;
    expect([...map.keys()]).toEqual(['/uploads/fast.png']);
  });
});

describe('替换地址', () => {
  it('把 src 换成 data: URL，尺寸不变', () => {
    const doc = docWithImages([{ src: '/uploads/a.png', width: 200, height: 100 }]);
    const ctx = buildExportContext(doc, 'sheet-0', opts());
    const next = applyImageSources(ctx, new Map([['/uploads/a.png', PNG]]));

    const size = next.sheets[0]!.layout.sizes.get('c-0')!;
    expect(size.image?.src).toBe(PNG);
    // 200×100 在 IMAGE_METRICS 的上限（320×240）之内，不该被缩放。
    expect(size.image?.width).toBe(200);
    expect(size.image?.height).toBe(100);
    // 原始上下文不被改写：`useMemo` 可能还握着它。
    expect(ctx.sheets[0]!.layout.sizes.get('c-0')!.image?.src).toBe('/uploads/a.png');
  });

  it('映射表为空时返回同一个对象', () => {
    const ctx = buildExportContext(docWithImages([{ src: '/uploads/a.png', width: 1, height: 1 }]), 'sheet-0', opts());
    expect(applyImageSources(ctx, new Map())).toBe(ctx);
  });

  it('表里没有的地址保持原样', () => {
    const doc = docWithImages([
      { src: '/uploads/a.png', width: 1, height: 1 },
      { src: '/uploads/b.png', width: 1, height: 1 },
    ]);
    const ctx = buildExportContext(doc, 'sheet-0', opts());
    const next = applyImageSources(ctx, new Map([['/uploads/a.png', PNG]]));
    expect(next.sheets[0]!.layout.sizes.get('c-0')!.image?.src).toBe(PNG);
    expect(next.sheets[0]!.layout.sizes.get('c-1')!.image?.src).toBe('/uploads/b.png');
  });

  it('布局尺寸不受影响（换地址不该改变排版）', () => {
    const doc = docWithImages([{ src: '/uploads/a.png', width: 200, height: 100 }]);
    const ctx = buildExportContext(doc, 'sheet-0', opts());
    const next = applyImageSources(ctx, new Map([['/uploads/a.png', PNG]]));
    expect(next.width).toBe(ctx.width);
    expect(next.height).toBe(ctx.height);
    expect(next.sheets[0]!.layout.boxes.get('c-0')).toBe(ctx.sheets[0]!.layout.boxes.get('c-0'));
  });
});
