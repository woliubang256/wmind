/**
 * 自动保存状态机（不依赖 React，可单独测）。
 *
 * 形状对齐 docs/05 §7.1：
 *
 *     idle ──编辑──▶ dirty ──防抖 800ms / 最长 5s──▶ saving
 *                      ▲                              │
 *                      └────────编辑──────────────────┤
 *                                                     ├─成功──▶ saved
 *                                                     ├─网络错──▶ 退避重试 3 次 ──▶ error
 *                                                     └─409────▶ conflict（暂停）
 *
 * 几个刻意的设计：
 *
 * 1. **`conflict` 是暂停态，不是错误态**。冲突时继续重试只会拿到同一个 409，
 *    把对话框刷屏。必须等用户明确选择「覆盖 / 放弃 / 另存」之后 `resume()`。
 * 2. **防抖与最长等待是两个计时器**。只有防抖的话，用户一直打字就永远不保存；
 *    只有最长等待的话，停下来之后要等满 5 秒才落盘，刷新就丢。
 * 3. **保存成功不等于干净**。请求往返期间用户可能又敲了几个字，是否干净由
 *    `revision` 判断（见 store 的 `markSaved`），这里只负责在「期间有编辑」时
 *    立刻再存一次。
 */

import { ApiError } from '@/lib/api/errors';
import type { SaveResult } from '@/lib/api/maps';
import type { WmindDocument } from '@/editor/model/types';

/** 编辑停止后多久落盘（docs/01 FR-MAP-11）。 */
export const DEFAULT_DEBOUNCE_MS = 800;
/** 连续编辑时最长多久强制落盘一次（同上）。 */
export const DEFAULT_MAX_WAIT_MS = 5000;
/** 网络类失败的退避间隔。三次之后放弃，转为 error 让用户手动重试。 */
export const DEFAULT_RETRY_DELAYS = [1000, 2000, 4000] as const;

export interface AutosaveSnapshot {
  document: WmindDocument;
  title: string;
  version: number;
  revision: number;
}

export interface AutosaveConflict {
  version: number;
  updatedAt: string | null;
}

export interface AutosaveOptions {
  /** 取当前快照。每次保存前调用，永远拿到最新的文档。 */
  read: () => AutosaveSnapshot;
  save: (input: { version: number; title: string; document: WmindDocument }) => Promise<SaveResult>;
  onSaving?: () => void;
  onSaved?: (result: SaveResult, revisionAtStart: number) => void;
  onConflict?: (conflict: AutosaveConflict) => void;
  onError?: (error: unknown) => void;
  debounceMs?: number;
  maxWaitMs?: number;
  retryDelays?: readonly number[];
}

export type FlushOutcome = 'saved' | 'skipped' | 'retrying' | 'failed' | 'conflict';

export interface AutosaveController {
  /** 有改动。重置防抖计时，并保证最长等待计时器在跑。 */
  notifyChange(): void;
  /** 立刻保存（Ctrl+S、离开页面前）。 */
  flush(): Promise<FlushOutcome>;
  /** 冲突处理完毕后恢复。 */
  resume(): void;
  /**
   * 把当前文档标记为「与服务端一致」。
   *
   * 用在「放弃我的修改」之后：刚拉下来的就是服务端版本，此时 revision 归零，
   * 若不重置这道闸门，订阅者会把它当成一次编辑，立刻把刚拉下来的
   * 文档再存回去——版本号白涨一次，另一个标签页平白收到冲突。
   */
  markClean(): void;
  /** 清掉所有计时器。卸载时调用。 */
  dispose(): void;  readonly paused: boolean;
  /** 是否有未落盘的改动（供离开保护判断）。 */
  hasPendingWork(): boolean;
}

function conflictFrom(error: unknown): AutosaveConflict | null {
  if (!(error instanceof ApiError) || error.code !== 'MAP_VERSION_CONFLICT') return null;
  const details = error.details as { currentVersion?: unknown; currentUpdatedAt?: unknown } | undefined;
  const version = typeof details?.currentVersion === 'number' ? details.currentVersion : 0;
  const updatedAt = typeof details?.currentUpdatedAt === 'string' ? details.currentUpdatedAt : null;
  return { version, updatedAt };
}

export function createAutosave(options: AutosaveOptions): AutosaveController {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const retryDelays = options.retryDelays ?? DEFAULT_RETRY_DELAYS;

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let maxWaitTimer: ReturnType<typeof setTimeout> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  let inFlight = false;
  /** 保存进行中又来了新改动 → 这一轮结束后立刻再存一次。 */
  let pending = false;
  let paused = false;
  let attempt = 0;
  /**
   * 上一次成功保存的那份文档（按引用比较）。
   *
   * 有了它，`run()` 才能在「其实没有改动」时直接返回：最长等待计时器可能
   * 在保存成功之后才到期，没有这道闸门就会白发一次请求——而每次请求都会
   * 让服务端版本号 +1，两个标签页的冲突会来得毫无道理。
   *
   * 用引用而不是 `revision`：immer 保证「没改动 = 同一个对象」，所以引用相等
   * 就是内容相等；而 `revision` 在 `loadDocument` 之后会归零，那时文档明明
   * 换了一份（恢复草稿），revision 却可能和上一次保存时一样。
   */
  let lastSavedDoc: WmindDocument | null = null;

  function clearTimers() {
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    if (maxWaitTimer !== null) clearTimeout(maxWaitTimer);
    if (retryTimer !== null) clearTimeout(retryTimer);
    debounceTimer = null;
    maxWaitTimer = null;
    retryTimer = null;
  }

  async function run(): Promise<FlushOutcome> {
    if (paused) return 'skipped';
    if (inFlight) {
      pending = true;
      return 'skipped';
    }

    const snapshot = options.read();
    if (lastSavedDoc === snapshot.document) return 'skipped';

    inFlight = true;
    options.onSaving?.();

    try {
      const result = await options.save({
        version: snapshot.version,
        title: snapshot.title,
        document: snapshot.document,
      });

      attempt = 0;
      lastSavedDoc = snapshot.document;
      // 这一轮已经落盘，最长等待计时器属于上一轮，清掉；下一笔改动会重新起算。
      if (maxWaitTimer !== null) {
        clearTimeout(maxWaitTimer);
        maxWaitTimer = null;
      }
      options.onSaved?.(result, snapshot.revision);

      // 期间又改过：文档已经比刚存上去的那份新，立刻再存一次。
      // 不重新走防抖——那会让「连续打字」变成每 800ms 存一次，
      // 而这里只在一次往返刚结束时补一次。
      const chained = pending;
      pending = false;
      inFlight = false;
      if (chained) return run();
      return 'saved';
    } catch (error) {
      inFlight = false;

      const conflict = conflictFrom(error);
      if (conflict) {
        // 暂停：继续重试只会拿到同一个 409。
        paused = true;
        pending = false;
        clearTimers();
        options.onConflict?.(conflict);
        return 'conflict';
      }

      if (attempt < retryDelays.length) {
        const delay = retryDelays[attempt];
        attempt += 1;
        retryTimer = setTimeout(() => {
          retryTimer = null;
          void run();
        }, delay);
        return 'retrying';
      }

      attempt = 0;
      // 必须把最长等待计时器一起清掉。它是在第一笔改动时起的，此刻还没到期；
      // 留着它会在几秒后再调一次 run()，于是「重试三次后放弃」变成每 5 秒
      // 重来一轮，界面在 error 与 saving 之间反复跳，而用户根本没再动过。
      clearTimers();
      options.onError?.(error);
      return 'failed';
    }
  }

  return {
    notifyChange(): void {
      if (paused) return;
      attempt = 0;
      if (debounceTimer !== null) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        void run();
      }, debounceMs);
      // 最长等待只在「第一笔改动」时起算，不随每次按键重置——
      // 重置的话连续打字永远不会触发它。
      if (maxWaitTimer === null) {
        maxWaitTimer = setTimeout(() => {
          maxWaitTimer = null;
          void run();
        }, maxWaitMs);
      }
    },

    flush(): Promise<FlushOutcome> {
      if (paused) return Promise.resolve('skipped');
      // 手动保存优先：用户按了 Ctrl+S，就不该等退避计时器。
      clearTimers();
      return run();
    },

    resume(): void {
      paused = false;
      attempt = 0;
    },

    markClean(): void {
      clearTimers();
      paused = false;
      pending = false;
      attempt = 0;
      lastSavedDoc = options.read().document;
    },

    dispose(): void {
      // 只清计时器，**不**留任何「已销毁」标记。
      //
      // React 的 StrictMode 会把 effect 跑两遍（挂载 → 清理 → 挂载），清理
      // 时调到的就是这个函数。留一个永久的 `disposed = true` 会让第二次挂载
      // 之后的控制器彻底哑掉——症状是「编辑了，页脚一直显示未保存，一个请求
      // 都不发」，而且只在开发模式下出现。
      clearTimers();
    },

    get paused(): boolean {
      return paused;
    },

    hasPendingWork(): boolean {
      return inFlight || pending || debounceTimer !== null || maxWaitTimer !== null || retryTimer !== null;
    },
  };
}
