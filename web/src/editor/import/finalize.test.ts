/**
 * 导入收尾（图片上传）的测试。
 *
 * 上传器全部是注入的假实现——这里验的是**编排**：谁先谁后、失败怎么收场、
 * 文档里的占位符有没有被换干净。真实 HTTP 与限流在 `lib/api` 与后端
 * `files_test.go` 里各自验过，混进来只会让失败原因变模糊。
 *
 * 断言的重点是「文档里不能留下 `xap:` 前缀的 src」：那是唯一一种会静默写进
 * 数据库、在界面上表现为一张永远转圈的破图、且没有任何报错的故障。
 */

import { describe, expect, it } from 'vitest';
import type { Sheet, Theme, Topic, TopicImage, WmindDocument } from '../model/types';
import { BUILTIN_PALETTES, themeFromPalette } from '../theme/palettes';
import { finalizeImport } from './finalize';
import type { ImportAsset, ImportResult, ImportWarning } from './types';

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

function topicOf(id: string, image: TopicImage | null = null): Topic {
  return {
    id,
    title: id,
    titleFormat: 'plain',
    structure: null,
    style: null,
    collapsed: false,
    href: '',
    notes: { plain: '', html: '' },
    labels: [],
    markers: [],
    image,
    children: { attached: [], detached: [] },
    summaries: [],
    boundaries: [],
    extensions: [],
  };
}

function sheetOf(root: Topic, floating: Topic[] = []): Sheet {
  return {
    id: `sheet-${root.id}`,
    title: '画布',
    structure: 'mindmap',
    rootTopic: root,
    floatingTopics: floating,
    relationships: [],
    boundaries: [],
    summaries: [],
    themeOverride: null,
    extensions: [],
  };
}

const palette = BUILTIN_PALETTES[0];
const theme = themeFromPalette(palette as NonNullable<typeof palette>);

function docOf(...sheets: Sheet[]): WmindDocument {
  return {
    format: 'wmind',
    formatVersion: '1.0',
    id: 'doc-1',
    title: '导入测试',
    theme: theme as Theme,
    sheets,
    meta: { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', app: 'wmind' },
    extensions: [],
  };
}

function assetOf(ref: string): ImportAsset {
  return { ref, bytes: new Uint8Array([1, 2, 3]), fileName: `resources/${ref.replace('xap:', '')}`, mime: 'image/png' };
}

function resultOf(document: WmindDocument, assets: ImportAsset[], warnings: ImportWarning[] = []): ImportResult {
  return {
    format: 'xmind',
    document,
    warnings,
    unsupported: {},
    summary: { sheets: document.sheets.length, topics: 1, maxDepth: 1, restored: ['image'] },
    assets,
  };
}

/** 成功上传：URL 由 ref 推导，方便断言「换成了哪一个」。 */
const okUploader = async (asset: ImportAsset) => ({ url: `https://files.test/${encodeURIComponent(asset.ref)}` });

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

describe('finalizeImport', () => {
  it('没有待上传的图片时原样返回', async () => {
    const document = docOf(sheetOf(topicOf('root')));
    const input = resultOf(document, []);

    const outcome = await finalizeImport(input, { upload: okUploader });

    // 同一个引用：没有图片时不该多造一个对象，调用方也就不必处理两种结果。
    expect(outcome.result).toBe(input);
    expect(outcome.uploaded).toBe(0);
    expect(outcome.skipped).toBe(0);
  });

  it('上传成功后把占位符换成服务端 URL', async () => {
    const root = topicOf('root', { src: 'xap:resources/a.png', width: 120, height: 80 });
    const outcome = await finalizeImport(resultOf(docOf(sheetOf(root)), [assetOf('xap:resources/a.png')]), {
      upload: okUploader,
    });

    expect(outcome.result.document.sheets[0]?.rootTopic.image?.src).toBe(
      'https://files.test/xap%3Aresources%2Fa.png',
    );
    // 宽高不动：尺寸是文件里写的，跟 URL 无关。
    expect(outcome.result.document.sheets[0]?.rootTopic.image?.width).toBe(120);
    expect(outcome.uploaded).toBe(1);
    expect(outcome.skipped).toBe(0);
  });

  it('上传失败时摘掉整张图，而不是留一个指向包内条目的死链', async () => {
    const root = topicOf('root', { src: 'xap:resources/a.png', width: 120, height: 80 });
    const outcome = await finalizeImport(resultOf(docOf(sheetOf(root)), [assetOf('xap:resources/a.png')]), {
      upload: async () => {
        throw new Error('boom');
      },
    });

    expect(outcome.result.document.sheets[0]?.rootTopic.image).toBeNull();
    expect(outcome.skipped).toBe(1);
    expect(outcome.result.warnings).toEqual([{ code: 'image-skipped', params: { count: 1 } }]);
  });

  it('与解析阶段已有的 image-skipped 合并计数，不重复出现同一条提示', async () => {
    const root = topicOf('root', { src: 'xap:resources/a.png', width: 120, height: 80 });
    const input = resultOf(docOf(sheetOf(root)), [assetOf('xap:resources/a.png')], [
      { code: 'image-skipped', params: { count: 2 } },
    ]);

    const outcome = await finalizeImport(input, {
      upload: async () => {
        throw new Error('boom');
      },
    });

    expect(outcome.result.warnings).toEqual([{ code: 'image-skipped', params: { count: 3 } }]);
  });

  it('外链图片既不上传也不被摘掉', async () => {
    const root = topicOf('root', { src: 'https://cdn.test/a.png', width: 120, height: 80 });
    const outcome = await finalizeImport(resultOf(docOf(sheetOf(root)), [assetOf('xap:resources/b.png')]), {
      upload: async () => {
        throw new Error('boom');
      },
    });

    expect(outcome.result.document.sheets[0]?.rootTopic.image?.src).toBe('https://cdn.test/a.png');
    // 一张都没传上去，但文档里确实还有图（外链），所以「已还原 图片」要留着。
    expect(outcome.result.summary.restored).toContain('image');
  });

  it('全部上传失败时把「已还原 图片」从摘要里去掉', async () => {
    const root = topicOf('root', { src: 'xap:resources/a.png', width: 120, height: 80 });
    const outcome = await finalizeImport(resultOf(docOf(sheetOf(root)), [assetOf('xap:resources/a.png')]), {
      upload: async () => {
        throw new Error('boom');
      },
    });

    expect(outcome.result.summary.restored).not.toContain('image');
    // 其余项不受影响。
    expect(outcome.result.summary.sheets).toBe(1);
  });

  it('有一张成功就保留「已还原 图片」', async () => {
    const root = topicOf('root', { src: 'xap:resources/a.png', width: 120, height: 80 });
    const child = topicOf('a', { src: 'xap:resources/b.png', width: 120, height: 80 });
    root.children.attached.push(child);

    const outcome = await finalizeImport(
      resultOf(docOf(sheetOf(root)), [assetOf('xap:resources/a.png'), assetOf('xap:resources/b.png')]),
      {
        upload: async (asset) => {
          if (asset.ref === 'xap:resources/b.png') throw new Error('boom');
          return { url: 'https://files.test/a.png' };
        },
      },
    );

    expect(outcome.uploaded).toBe(1);
    expect(outcome.skipped).toBe(1);
    expect(outcome.result.summary.restored).toContain('image');
    expect(outcome.result.document.sheets[0]?.rootTopic.children.attached[0]?.image).toBeNull();
  });

  it('撞上 429 就停手，不再继续打请求', async () => {
    const root = topicOf('root');
    for (const id of ['a', 'b', 'c']) {
      root.children.attached.push(topicOf(id, { src: `xap:resources/${id}.png`, width: 120, height: 80 }));
    }
    let calls = 0;
    const outcome = await finalizeImport(
      resultOf(docOf(sheetOf(root)), [
        assetOf('xap:resources/a.png'),
        assetOf('xap:resources/b.png'),
        assetOf('xap:resources/c.png'),
      ]),
      {
        upload: async () => {
          calls += 1;
          // 客户端抛的是 ApiError，只用到它的 code。
          throw Object.assign(new Error('rate limited'), { code: 'RATE_LIMITED' });
        },
      },
    );

    expect(calls).toBe(1);
    expect(outcome.uploaded).toBe(0);
    expect(outcome.skipped).toBe(3);
    expect(outcome.result.warnings).toEqual([{ code: 'image-skipped', params: { count: 3 } }]);
    for (const child of root.children.attached) expect(child.image).toBeNull();
  });

  it('逐张回调进度，成功失败都算', async () => {
    const root = topicOf('root', { src: 'xap:resources/a.png', width: 120, height: 80 });
    root.children.attached.push(topicOf('a', { src: 'xap:resources/b.png', width: 120, height: 80 }));
    const seen: string[] = [];

    await finalizeImport(
      resultOf(docOf(sheetOf(root)), [assetOf('xap:resources/a.png'), assetOf('xap:resources/b.png')]),
      {
        upload: async (asset) => {
          if (asset.ref === 'xap:resources/b.png') throw new Error('boom');
          return { url: 'https://files.test/a.png' };
        },
        onProgress: (done, total) => seen.push(`${done}/${total}`),
      },
    );

    expect(seen).toEqual(['1/2', '2/2']);
  });

  it('自由主题与 detached 子树的图片也换掉', async () => {
    const root = topicOf('root');
    const floating = topicOf('f', { src: 'xap:resources/f.png', width: 120, height: 80 });
    const detached = topicOf('d', { src: 'xap:resources/d.png', width: 120, height: 80 });
    root.children.detached.push(detached);

    const outcome = await finalizeImport(
      resultOf(docOf(sheetOf(root, [floating])), [assetOf('xap:resources/f.png'), assetOf('xap:resources/d.png')]),
      { upload: okUploader },
    );

    expect(outcome.uploaded).toBe(2);
    expect(floating.image?.src).toBe('https://files.test/xap%3Aresources%2Ff.png');
    expect(detached.image?.src).toBe('https://files.test/xap%3Aresources%2Fd.png');
  });

  it('上传完清空 assets，避免上百 MB 的字节继续挂在结果里', async () => {
    const root = topicOf('root', { src: 'xap:resources/a.png', width: 120, height: 80 });
    const outcome = await finalizeImport(resultOf(docOf(sheetOf(root)), [assetOf('xap:resources/a.png')]), {
      upload: okUploader,
    });

    expect(outcome.result.assets).toEqual([]);
  });

  it('深链不退化成递归爆栈', async () => {
    // 节点上限允许 2 万个，退化成一条链时递归深度就等于节点数。
    const root = topicOf('n0', { src: 'xap:resources/a.png', width: 120, height: 80 });
    let cursor = root;
    for (let i = 1; i < 5000; i += 1) {
      const next = topicOf(`n${i}`);
      cursor.children.attached.push(next);
      cursor = next;
    }

    const outcome = await finalizeImport(resultOf(docOf(sheetOf(root)), [assetOf('xap:resources/a.png')]), {
      upload: okUploader,
    });

    expect(outcome.result.document.sheets[0]?.rootTopic.image?.src).toBe(
      'https://files.test/xap%3Aresources%2Fa.png',
    );
  });
});
