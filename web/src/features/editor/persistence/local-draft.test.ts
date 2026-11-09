import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDocument } from '@/editor/model/create';
import {
  DRAFT_PREFIX,
  DRAFT_TTL_MS,
  clearDraft,
  isDraftNewer,
  pruneDrafts,
  readDraft,
  sameDocument,
  writeDraft,
} from './local-draft';

/**
 * 测试环境是 node，没有 localStorage，所以自己塞一个假的。
 * 用 `vi.stubGlobal` 而不是改模块内部实现：生产代码读的是 `window.localStorage`，
 * 假装一个 window 就能覆盖到真实的读取路径。
 */
class FakeStorage implements Storage {
  private map = new Map<string, string>();

  get length(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }

  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }

  /** 让写入抛异常，模拟配额满。 */
  failNext = false;
  [name: string]: unknown;
}

function installStorage(): FakeStorage {
  const storage = new FakeStorage();
  const original = storage.setItem.bind(storage);
  storage.setItem = (key: string, value: string) => {
    if (storage.failNext) throw new Error('QuotaExceededError');
    original(key, value);
  };
  vi.stubGlobal('window', { localStorage: storage });
  return storage;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('本地草稿', () => {
  it('写入后能读回来', () => {
    installStorage();
    const document = createDocument({ title: '草稿' });
    expect(writeDraft({ uid: 'm1', document, savedAt: 1000 })).toBe(true);

    const draft = readDraft('m1', 2000);
    expect(draft?.uid).toBe('m1');
    expect(draft?.savedAt).toBe(1000);
    expect(draft?.document.title).toBe('草稿');
  });

  it('不同导图的草稿互不干扰', () => {
    installStorage();
    writeDraft({ uid: 'a', document: createDocument({ title: 'A' }), savedAt: 1000 });
    writeDraft({ uid: 'b', document: createDocument({ title: 'B' }), savedAt: 1000 });
    expect(readDraft('a', 2000)?.document.title).toBe('A');
    expect(readDraft('b', 2000)?.document.title).toBe('B');
  });

  it('超过 7 天的草稿读不到，并且被删掉', () => {
    const storage = installStorage();
    writeDraft({ uid: 'm1', document: createDocument({ title: '旧草稿' }), savedAt: 1000 });

    expect(readDraft('m1', 1000 + DRAFT_TTL_MS + 1)).toBeNull();
    expect(storage.getItem(`${DRAFT_PREFIX}m1`)).toBeNull();
  });

  it('形状不对的内容当没写过', () => {
    const storage = installStorage();
    storage.setItem(`${DRAFT_PREFIX}m1`, JSON.stringify({ uid: 'm1', savedAt: 1000, document: { format: 'other' } }));
    expect(readDraft('m1', 2000)).toBeNull();
    // 坏数据要顺手清掉，否则每次打开都白解析一遍。
    expect(storage.getItem(`${DRAFT_PREFIX}m1`)).toBeNull();
  });

  it('不是 JSON 也不炸', () => {
    const storage = installStorage();
    storage.setItem(`${DRAFT_PREFIX}m1`, '{{{{');
    expect(readDraft('m1', 2000)).toBeNull();
  });

  it('缺字段的旧草稿被补全，而不是原样交给渲染层', () => {
    const storage = installStorage();
    // 形状闸门只认 format 与 sheets，这份能过；但渲染层要读
    // `theme.global.fontFamily`，原样交出去就是整页白屏。
    storage.setItem(
      `${DRAFT_PREFIX}m1`,
      JSON.stringify({
        uid: 'm1',
        savedAt: 1000,
        document: {
          format: 'wmind',
          formatVersion: '1.0',
          id: 'd1',
          title: '旧草稿',
          sheets: [{ id: 's1', rootTopic: { id: 'r', title: '中心' } }],
        },
      }),
    );
    const draft = readDraft('m1', 2000);
    expect(draft).not.toBeNull();
    expect(draft?.document.theme.global.fontFamily).toBeTruthy();
    expect(draft?.document.sheets[0]?.rootTopic.children.attached).toEqual([]);
  });

  it('归一化都救不回来的草稿直接丢弃', () => {
    const storage = installStorage();
    storage.setItem(
      `${DRAFT_PREFIX}m1`,
      JSON.stringify({
        uid: 'm1',
        savedAt: 1000,
        // formatVersion 的 major 高于本版本：属于「读不懂的未来格式」，
        // 硬读下去只会让用户以为内容丢了。
        document: { format: 'wmind', formatVersion: '9.0', sheets: [{ rootTopic: { id: 'r', title: 't' } }] },
      }),
    );
    expect(readDraft('m1', 2000)).toBeNull();
    expect(storage.getItem(`${DRAFT_PREFIX}m1`)).toBeNull();
  });

  it('配额满时静默降级，不抛异常', () => {
    const storage = installStorage();
    storage.failNext = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(writeDraft({ uid: 'm1', document: createDocument({ title: 'x' }), savedAt: 1 })).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('没有 localStorage 时全部安全返回', () => {
    vi.stubGlobal('window', undefined);
    expect(writeDraft({ uid: 'm1', document: createDocument({ title: 'x' }), savedAt: 1 })).toBe(false);
    expect(readDraft('m1', 2000)).toBeNull();
    expect(() => clearDraft('m1')).not.toThrow();
    expect(pruneDrafts(2000)).toBe(0);
  });

  it('clearDraft 之后读不到', () => {
    installStorage();
    writeDraft({ uid: 'm1', document: createDocument({ title: 'x' }), savedAt: 1000 });
    clearDraft('m1');
    expect(readDraft('m1', 2000)).toBeNull();
  });

  it('pruneDrafts 只清过期的，不动新的', () => {
    const storage = installStorage();
    const document = createDocument({ title: 'x' });
    writeDraft({ uid: 'old', document, savedAt: 1000 });
    writeDraft({ uid: 'new', document, savedAt: 1000 + DRAFT_TTL_MS });
    storage.setItem(`${DRAFT_PREFIX}broken`, 'not json');

    const removed = pruneDrafts(1000 + DRAFT_TTL_MS + 1);
    expect(removed).toBe(2); // old + broken
    expect(readDraft('new', 1000 + DRAFT_TTL_MS + 1)).not.toBeNull();
  });

  it('isDraftNewer 按时间比较，服务端时间解析失败时保守返回 false', () => {
    const document = createDocument({ title: 'x' });
    const draft = { uid: 'm1', document, savedAt: 2000 };
    expect(isDraftNewer(draft, '1970-01-01T00:00:01.000Z')).toBe(true);
    expect(isDraftNewer(draft, '1970-01-01T00:10:00.000Z')).toBe(false);
    expect(isDraftNewer(draft, 'not-a-date')).toBe(false);
  });

  it('sameDocument 比较内容而不是引用', () => {
    const a = createDocument({ title: 'x' });
    // 深拷贝一份：内容一样但引用不同。
    const copy = JSON.parse(JSON.stringify(a)) as typeof a;
    expect(a).not.toBe(copy);
    expect(sameDocument(a, copy)).toBe(true);
    expect(sameDocument(a, createDocument({ title: 'y' }))).toBe(false);
  });
});
