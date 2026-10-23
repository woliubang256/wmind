import { describe, expect, it, vi } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { IMPORT_LIMITS } from '@/editor/import/limits';
import { createImportBatch, prepareImportBatch, type ImportBatchSource } from './import-batch';

const source = (name: string, text: string): ImportBatchSource => ({ name, size: text.length, read: async () => new TextEncoder().encode(text) });
const options = () => ({ isCurrent: () => true, upload: vi.fn(), onProgress: vi.fn() });

describe('批量导入', () => {
  it('保留选择顺序，坏文件和超限项不阻断后续，超限项不读取', async () => {
    const read = vi.fn();
    const items = await prepareImportBatch([
      source('first.md', '# 第一份'), source('invalid.bin', 'bad-format'),
      { name: 'large.xmind', size: IMPORT_LIMITS.maxInputBytes + 1, read }, source('last.md', '# 最后一份'),
    ], options());
    expect(items?.map((item) => item.fileName)).toEqual(['first.md', 'invalid.bin', 'large.xmind', 'last.md']);
    expect(items?.map((item) => item.result?.document.title ?? null)).toEqual(['第一份', null, null, '最后一份']);
    expect(read).not.toHaveBeenCalled();
  });

  it('关闭读取中的任务后不再读取后续文件或返回旧结果', async () => {
    let active = true;
    let release!: (bytes: Uint8Array) => void;
    const read = vi.fn(() => new Promise<Uint8Array>((resolve) => { release = resolve; }));
    const next = vi.fn();
    const running = prepareImportBatch([{ name: 'slow.md', size: 10, read }, { name: 'next.md', size: 10, read: next }], { ...options(), isCurrent: () => active });
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    active = false;
    release(new TextEncoder().encode('# 旧结果'));
    expect(await running).toBeNull();
    expect(next).not.toHaveBeenCalled();
  });

  it('图片限流后整个批次停止上传请求，后续文档继续解析且如实记录图片丢失', async () => {
    const bytes = zipSync({
      'content.json': strToU8(JSON.stringify([{ rootTopic: { title: '含图主题', image: { src: 'xap:resources/a.png' } } }])),
      'resources/a.png': new Uint8Array([1]),
    });
    const upload = vi.fn(async () => { throw { code: 'RATE_LIMITED' }; });
    const items = await prepareImportBatch(['first.xmind', 'second.xmind'].map((name) => ({ name, size: bytes.byteLength, read: async () => bytes })), { ...options(), upload });
    expect(upload).toHaveBeenCalledOnce();
    expect(items).toHaveLength(2);
    for (const item of items!) {
      expect(item.result?.document.sheets[0]!.rootTopic.image).toBeNull();
      expect(item.result?.warnings).toContainEqual({ code: 'image-skipped', params: { count: 1 } });
    }
  });

  it('创建失败继续处理，最后成功项保持选择顺序，重试不重复创建成功项', async () => {
    const items = (await prepareImportBatch([source('first.md', '# 一'), source('second.md', '# 二'), source('third.md', '# 三')], options()))!;
    const create = vi.fn(async ({ title }: { title: string }) => {
      if (title === '二') throw new Error('unavailable');
      return { uid: title };
    });
    const completed = await createImportBatch(items, create, () => true, vi.fn());
    expect(create.mock.calls.map(([input]) => input.title)).toEqual(['一', '二', '三']);
    expect(completed?.filter((item) => item.createdUid).at(-1)?.createdUid).toBe('三');
    create.mockClear();
    await createImportBatch(completed!, create, () => true, vi.fn());
    expect(create.mock.calls.map(([input]) => input.title)).toEqual(['二']);
  });

  it('卸载期间已发出的创建返回后不再创建下一项，也不回写界面', async () => {
    const items = (await prepareImportBatch([source('a.md', '# 一'), source('b.md', '# 二')], options()))!;
    let active = true;
    let release!: (result: { uid: string }) => void;
    const create = vi.fn(() => new Promise<{ uid: string }>((resolve) => { release = resolve; }));
    const onItem = vi.fn();
    const running = createImportBatch(items, create, () => active, onItem);
    active = false;
    release({ uid: 'already-created' });
    expect(await running).toBeNull();
    expect(create).toHaveBeenCalledOnce();
    expect(onItem).not.toHaveBeenCalled();
  });
});
