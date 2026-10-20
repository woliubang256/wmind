/**
 * 本地草稿（docs/05 §7.4）。
 *
 * 自动保存的失败模式里有一种它救不了的：**标签页直接没了**（崩溃、断电、
 * 手滑关了窗口）。请求还没发出去，服务端什么都没收到，内存里的文档随进程
 * 一起消失。所以每隔几秒往 localStorage 写一份，作为第二道保险。
 *
 * 三件必须做对的事：
 *
 * 1. **写失败不能炸**。Safari 隐私模式、配额满、被用户禁用——localStorage
 *    抛异常是常态，而丢草稿只是「少一层保险」，不该让编辑器崩掉。
 * 2. **读要验形状**。localStorage 是用户能手改的，也是上一个版本的前端写的。
 *    直接 `JSON.parse` 之后当文档用，会在布局阶段炸在某个想不到的地方。
 * 3. **要能过期**。草稿是「意外」的产物，不是版本历史。7 天前的草稿恢复回来
 *    只会覆盖掉用户这周的正常工作。
 */

import { parseDocument } from '@/editor/model/validate';
import type { WmindDocument } from '@/editor/model/types';

export const DRAFT_PREFIX = 'wmind:draft:';
export const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface LocalDraft {
  uid: string;
  document: WmindDocument;
  /** 写入时间（毫秒）。与服务端 `updatedAt` 比较，判断草稿是否更新。 */
  savedAt: number;
}

function storage(): Storage | null {
  try {
    // 访问 localStorage 本身就可能抛（隐私模式 / 禁用 Cookie）。
    return window.localStorage;
  } catch {
    return null;
  }
}

/** 写草稿。返回是否真的写进去了——调用方据此决定是否提示「本地草稿不可用」。 */
export function writeDraft(draft: LocalDraft): boolean {
  const store = storage();
  if (!store) return false;
  try {
    store.setItem(DRAFT_PREFIX + draft.uid, JSON.stringify(draft));
    return true;
  } catch (error) {
    // 配额满是最常见的：一张 1 MB 的图乘以若干张就撑爆 5 MB 的默认配额。
    // 静默降级——真正的保存仍然会成功，只是少了这层保险。
    console.warn('[wmind] 本地草稿写入失败', error);
    return false;
  }
}

function isValidDraft(value: unknown, uid: string): value is LocalDraft {
  if (typeof value !== 'object' || value === null) return false;
  const draft = value as Partial<LocalDraft>;
  if (draft.uid !== uid) return false;
  if (typeof draft.savedAt !== 'number' || !Number.isFinite(draft.savedAt)) return false;
  const doc = draft.document as Partial<WmindDocument> | undefined;
  if (typeof doc !== 'object' || doc === null) return false;
  if (doc.format !== 'wmind') return false;
  if (!Array.isArray(doc.sheets) || doc.sheets.length === 0) return false;
  return true;
}

/**
 * 读草稿。不存在、已过期、形状不对都返回 null。
 *
 * 形状过关之后还要**过一遍归一化**：`isValidDraft` 只确认「format 对、有画布」，
 * 而渲染层真正需要的是 `theme.global.fontFamily` 这类必填字段——缺一个就是整页
 * 白屏。草稿可能是上一个版本的前端写的，补全这一步不能省。补全失败说明它已经
 * 不是本版本能读的文档，直接丢弃（用户还有服务端那一份）。
 */
export function readDraft(uid: string, now: number = Date.now()): LocalDraft | null {
  const store = storage();
  if (!store) return null;
  let raw: string | null;
  try {
    raw = store.getItem(DRAFT_PREFIX + uid);
  } catch {
    return null;
  }
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isValidDraft(parsed, uid)) {
    clearDraft(uid);
    return null;
  }
  if (now - parsed.savedAt > DRAFT_TTL_MS) {
    clearDraft(uid);
    return null;
  }

  try {
    return { ...parsed, document: parseDocument(parsed.document).document };
  } catch {
    clearDraft(uid);
    return null;
  }
}

export function clearDraft(uid: string): void {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(DRAFT_PREFIX + uid);
  } catch {
    // 删不掉就删不掉，下一次写入会覆盖它。
  }
}

/**
 * 清理过期草稿，返回清掉的条数。
 *
 * 在打开任意一张导图时顺带跑一次：单独做一个「清理任务」需要定时器，
 * 而用户打开导图时本来就要遍历 localStorage，顺手就清完了。
 */
export function pruneDrafts(now: number = Date.now()): number {
  const store = storage();
  if (!store) return 0;
  const expired: string[] = [];
  try {
    for (let i = 0; i < store.length; i += 1) {
      const key = store.key(i);
      if (!key || !key.startsWith(DRAFT_PREFIX)) continue;
      const raw = store.getItem(key);
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw) as Partial<LocalDraft>;
        if (typeof parsed.savedAt !== 'number' || now - parsed.savedAt > DRAFT_TTL_MS) {
          expired.push(key);
        }
      } catch {
        expired.push(key);
      }
    }
    for (const key of expired) store.removeItem(key);
  } catch {
    return 0;
  }
  return expired.length;
}

/** 草稿是否比服务端版本更新。服务端时间解析失败时保守地认为「不更新」。 */
export function isDraftNewer(draft: LocalDraft, serverUpdatedAt: string): boolean {
  const serverTime = Date.parse(serverUpdatedAt);
  if (!Number.isFinite(serverTime)) return false;
  return draft.savedAt > serverTime;
}

/** 两份文档内容是否一致。用于「草稿比服务端新但其实内容一样」的情况。 */
export function sameDocument(a: WmindDocument, b: WmindDocument): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
