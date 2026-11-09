import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api/errors';
import { createDocument } from '@/editor/model/create';
import type { WmindDocument } from '@/editor/model/types';
import type { SaveResult } from '@/lib/api/maps';
import { createAutosave, type AutosaveController } from './autosave';

/**
 * 自动保存是这一批里唯一「错了会丢数据」的部件，所以每条分支都要有用例：
 * 防抖、最长等待、成功、期间又编辑、409 暂停、网络重试、手动保存。
 */

interface Harness {
  ctrl: AutosaveController;
  calls: { version: number; title: string; document: WmindDocument }[];
  events: string[];
  /** 改一次文档（换引用，模拟 immer 产出新文档）。 */
  touch(): void;
  /** 换一份「从服务器拉下来的」文档。 */
  replace(doc: WmindDocument): void;
  setVersion(version: number): void;
  /** 让下一次保存成功 / 失败 / 挂起。 */
  respondWith(fn: (() => Promise<SaveResult>) | null): void;
}

function harness(options: { debounceMs?: number; maxWaitMs?: number; retryDelays?: number[] } = {}): Harness {
  let doc = createDocument({ title: '未命名' });
  let version = 1;
  let revision = 0;
  const calls: Harness['calls'] = [];
  const events: string[] = [];
  let responder: (() => Promise<SaveResult>) | null = null;

  const ctrl = createAutosave({
    read: () => ({ document: doc, title: doc.title, version, revision }),
    save: (input) => {
      calls.push(input);
      if (responder) return responder();
      return Promise.resolve({ uid: 'u1', version: version + 1, nodeCount: 1, updatedAt: '2026-10-18T00:00:00Z' });
    },
    onSaving: () => events.push('saving'),
    onSaved: (result) => {
      events.push(`saved:${result.version}`);
      version = result.version;
    },
    onConflict: (conflict) => events.push(`conflict:${conflict.version}`),
    onError: () => events.push('error'),
    debounceMs: options.debounceMs ?? 100,
    maxWaitMs: options.maxWaitMs ?? 1000,
    retryDelays: options.retryDelays ?? [10, 20, 40],
  });

  return {
    ctrl,
    calls,
    events,
    touch() {
      revision += 1;
      doc = { ...doc, meta: { ...doc.meta, updatedAt: new Date(revision).toISOString() } };
    },
    replace(next) {
      doc = next;
      revision = 0;
    },
    setVersion(next) {
      version = next;
    },
    respondWith(fn) {
      responder = fn;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('自动保存状态机', () => {
  it('编辑停止 100ms 后才保存，连续编辑只保存一次', async () => {
    const h = harness();
    h.touch();
    h.ctrl.notifyChange();
    await vi.advanceTimersByTimeAsync(50);
    expect(h.calls).toHaveLength(0);

    h.touch();
    h.ctrl.notifyChange();
    await vi.advanceTimersByTimeAsync(50);
    expect(h.calls).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(60);
    expect(h.calls).toHaveLength(1);
    expect(h.events).toEqual(['saving', 'saved:2']);
  });

  it('一直打字也会在最长等待时间强制落盘', async () => {
    const h = harness({ debounceMs: 100, maxWaitMs: 1000 });
    // 每 90ms 改一次：防抖永远凑不满 100ms，只有最长等待能救。
    for (let i = 0; i < 12; i += 1) {
      h.touch();
      h.ctrl.notifyChange();
      await vi.advanceTimersByTimeAsync(90);
    }
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.version).toBe(1);
  });

  it('保存成功后版本号推进，再编辑用新版本号', async () => {
    const h = harness();
    h.touch();
    h.ctrl.notifyChange();
    await vi.advanceTimersByTimeAsync(120);
    expect(h.calls[0]?.version).toBe(1);

    h.touch();
    h.ctrl.notifyChange();
    await vi.advanceTimersByTimeAsync(120);
    expect(h.calls[1]?.version).toBe(2);
  });

  it('没有改动时 flush 不发请求', async () => {
    const h = harness();
    // 刚加载完就按 Ctrl+S：文档和服务端一致，不该白涨一次版本号。
    h.ctrl.markClean();
    expect(await h.ctrl.flush()).toBe('skipped');
    expect(h.calls).toHaveLength(0);
  });

  it('保存期间又编辑：这一轮结束后立刻补存一次', async () => {
    const h = harness();
    // 用对象接住 resolve：直接 `let release` 会被 TS 的控制流分析窄化成 never
    // （赋值发生在回调里，它看不见）。
    const pending: { release?: () => void } = {};
    h.respondWith(
      () =>
        new Promise<SaveResult>((resolve) => {
          pending.release = () => resolve({ uid: 'u1', version: 2, nodeCount: 1, updatedAt: '2026-10-18T00:00:00Z' });
        }),
    );

    h.touch();
    h.ctrl.notifyChange();
    await vi.advanceTimersByTimeAsync(120);
    expect(h.calls).toHaveLength(1);

    // 请求还在路上，用户又敲了几个字。
    h.touch();
    h.ctrl.notifyChange();
    await vi.advanceTimersByTimeAsync(120);
    expect(h.calls).toHaveLength(1); // 不能并发发第二次

    pending.release?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]?.version).toBe(2); // 用刚拿到的版本号
  });

  it('409 之后暂停，不再重试；resume 后恢复', async () => {
    const h = harness();
    h.respondWith(() =>
      Promise.reject(
        new ApiError(
          {
            error: {
              code: 'MAP_VERSION_CONFLICT',
              message: 'conflict',
              details: { currentVersion: 7, currentUpdatedAt: '2026-10-18T10:00:00Z' },
            },
          },
          409,
        ),
      ),
    );

    h.touch();
    h.ctrl.notifyChange();
    await vi.advanceTimersByTimeAsync(120);
    expect(h.events).toContain('conflict:7');
    expect(h.ctrl.paused).toBe(true);

    // 暂停期间继续编辑：不能每 800ms 撞一次 409 把对话框刷屏。
    h.touch();
    h.ctrl.notifyChange();
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.calls).toHaveLength(1);

    h.respondWith(null);
    h.ctrl.resume();
    expect(h.ctrl.paused).toBe(false);
    expect(await h.ctrl.flush()).toBe('saved');
    expect(h.calls).toHaveLength(2);
  });

  it('网络错误按退避重试三次，之后转 error', async () => {
    const h = harness({ retryDelays: [10, 20, 40] });
    h.respondWith(() => Promise.reject(new Error('network down')));

    h.touch();
    h.ctrl.notifyChange();
    // 100ms 是防抖；退避计时器（10/20/40）要一段一段推进，
    // 一次性跳过 120ms 会把第一次重试也带过去，看起来像「首存就发了两次」。
    await vi.advanceTimersByTimeAsync(100);
    expect(h.calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(10);
    expect(h.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(20);
    expect(h.calls).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(40);
    expect(h.calls).toHaveLength(4);

    await vi.advanceTimersByTimeAsync(1000);
    expect(h.calls).toHaveLength(4); // 不再无限重试
    expect(h.events).toContain('error');
  });

  it('重试成功后不再报错', async () => {
    const h = harness({ retryDelays: [10] });
    let fail = true;
    h.respondWith(() => {
      if (fail) {
        fail = false;
        return Promise.reject(new Error('flaky'));
      }
      return Promise.resolve({ uid: 'u1', version: 2, nodeCount: 1, updatedAt: '2026-10-18T00:00:00Z' });
    });

    h.touch();
    h.ctrl.notifyChange();
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(10);
    expect(h.events).not.toContain('error');
    expect(h.events).toContain('saved:2');
  });

  it('markClean 之后不会把刚拉下来的文档又存回去', async () => {
    const h = harness();
    h.touch();
    h.ctrl.notifyChange();
    await vi.advanceTimersByTimeAsync(120);
    expect(h.calls).toHaveLength(1);

    // 「放弃我的修改」：换成服务器文档 + markClean。
    h.replace(createDocument({ title: '服务器版本' }));
    h.ctrl.markClean();
    expect(await h.ctrl.flush()).toBe('skipped');
    expect(h.calls).toHaveLength(1);
  });

  it('flush 立刻保存，不等防抖', async () => {
    const h = harness();
    h.touch();
    h.ctrl.notifyChange();
    expect(await h.ctrl.flush()).toBe('saved');
    expect(h.calls).toHaveLength(1);
  });

  it('dispose 之后不再发请求', async () => {
    const h = harness();
    h.touch();
    h.ctrl.notifyChange();
    h.ctrl.dispose();
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.calls).toHaveLength(0);
  });

  it('hasPendingWork 反映是否有未完成的活', async () => {
    const h = harness();
    expect(h.ctrl.hasPendingWork()).toBe(false);
    h.touch();
    h.ctrl.notifyChange();
    expect(h.ctrl.hasPendingWork()).toBe(true);
    await vi.advanceTimersByTimeAsync(120);
    expect(h.ctrl.hasPendingWork()).toBe(false);
  });
});
