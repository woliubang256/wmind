/**
 * 把自动保存接到 store 上（React 侧）。
 *
 * 这一层只做三件事：把 store 的变化喂给状态机、把状态机的结果写回 store、
 * 以及「离开页面」的两种拦截（关标签页 / 路由切换）。
 *
 * 关于 `useState(() => createAutosave(...))`：控制器只在挂载时建一次，闭包里
 * 捕获的 `store` 与 `uid` 在组件生命周期内不会变——编辑器页按 uid 重建
 * store，换 uid 就是换组件实例。
 */

import { useCallback, useEffect, useState } from 'react';
import { useBlocker, useNavigate } from 'react-router';
import i18n from '@/lib/i18n';
import { mapApi } from '@/lib/api/maps';
import type { WmindDocument } from '@/editor/model/types';
import type { EditorStore, EditorState } from '@/editor/store/editor-store';
import { createAutosave, type AutosaveConflict, type FlushOutcome } from './autosave';
import { clearDraft, readDraft, writeDraft, type LocalDraft } from './local-draft';

/** 草稿落盘间隔（docs/05 §7.4）。 */
export const DRAFT_INTERVAL_MS = 3000;

/** 有未落盘的内容吗？离开保护与 beforeunload 共用这一个判断。 */
export function hasUnsavedWork(state: EditorState): boolean {
  return (
    state.save.status === 'dirty' ||
    state.save.status === 'error' ||
    state.save.status === 'conflict'
  );
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return i18n.t('editor.save.failedGeneric');
}

export interface UseAutosaveResult {
  /** 立即保存（Ctrl+S）。 */
  flush: () => Promise<FlushOutcome>;
  /** 失败后手动重试。 */
  retry: () => void;
  conflict: AutosaveConflict | null;
  /** 保留我的版本：拿服务器版本号重发一次。 */
  overwrite: () => Promise<void>;
  /** 放弃我的修改：拉服务端文档替换本地。 */
  reload: () => Promise<void>;
  /** 另存为副本：本地内容建成新导图，原导图保持服务端版本。 */
  saveAsCopy: () => Promise<void>;
  /** 冲突处理中的忙碌态，用于禁用对话框按钮。 */
  resolving: boolean;
  /** 路由切换被拦下（有未保存内容）。 */
  blocked: boolean;
  /** 留在当前页。 */
  stay: () => void;
  /** 写草稿后离开。 */
  leave: () => void;
}

export interface UseAutosaveOptions {
  uid: string;
  store: EditorStore;
  /**
   * 是否挂自动保存。
   *
   * 演示文档与压测文档（`/maps/stress`）没有服务端记录，给它们挂自动保存
   * 只会每 800ms 撞一次 404。用开关而不是两个组件：页面主体、快捷键、
   * 离开保护都是一套代码，复制一份出来必然走样。
   */
  enabled?: boolean;
}

export function useAutosave({ uid, store, enabled = true }: UseAutosaveOptions): UseAutosaveResult {
  const navigate = useNavigate();
  const [conflict, setConflict] = useState<AutosaveConflict | null>(null);
  const [resolving, setResolving] = useState(false);

  const [controller] = useState(() =>
    createAutosave({
      read: () => {
        const state = store.getState();
        return {
          document: state.doc,
          title: state.doc.title,
          version: state.version,
          revision: state.revision,
        };
      },
      save: (input) => mapApi.save(uid, input),
      onSaving: () => store.getState().setSave({ status: 'saving', error: null }),
      onSaved: (result, revisionAtStart) => {
        store.getState().markSaved(result.version, revisionAtStart);
        // 已经落盘，草稿没用了。留着它只会在下次打开时弹出「发现本地修改」，
        // 而那份「本地修改」和服务端完全一样。
        clearDraft(uid);
      },
      onConflict: (found) => {
        store.getState().markConflict(found.version, found.updatedAt);
        setConflict(found);
      },
      onError: (error) => {
        store.getState().setSave({ status: 'error', error: messageOf(error) });
      },
    }),
  );

  useEffect(() => () => controller.dispose(), [controller]);

  // 挂载时把状态落成「已保存」：刚打开的文档和服务端一致，页脚显示一个
  // 「—」会让用户以为保存功能没生效。同时 markClean 让 Ctrl+S 不会白存一次。
  useEffect(() => {
    if (!enabled) return;
    controller.markClean();
    store.getState().setSave({ status: 'saved', at: Date.now(), error: null, conflict: null });
  }, [enabled, store, controller]);

  // 只有 revision 变化才算「编辑」。选中、平移、改视口都会触发 store 的订阅，
  // 拿它们去排保存等于每拖一下画布就存一次。
  useEffect(() => {
    if (!enabled) return undefined;
    let lastRevision = store.getState().revision;
    return store.subscribe((state) => {
      if (state.revision === lastRevision) return;
      lastRevision = state.revision;
      controller.notifyChange();
    });
  }, [enabled, store, controller]);

  // 草稿：每 3 秒检查一次。只在有未落盘内容时写，写完不删（删要等保存成功）。
  useEffect(() => {
    if (!enabled) return undefined;
    const timer = setInterval(() => {
      const state = store.getState();
      if (!hasUnsavedWork(state)) return;
      writeDraft({ uid, document: state.doc, savedAt: Date.now() });
    }, DRAFT_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [enabled, uid, store]);

  // 关标签页 / 刷新：beforeunload 提示 + 同步写一次草稿（pagehide 里还能写）。
  useEffect(() => {
    if (!enabled) return undefined;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!hasUnsavedWork(store.getState())) return;
      // 现代浏览器忽略自定义文案，但必须 preventDefault + 赋值才显示默认提示。
      event.preventDefault();
      event.returnValue = '';
    };
    const onPageHide = () => {
      const state = store.getState();
      if (!hasUnsavedWork(state)) return;
      writeDraft({ uid, document: state.doc, savedAt: Date.now() });
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      window.removeEventListener('pagehide', onPageHide);
    };
  }, [enabled, uid, store]);

  const blocker = useBlocker(
    useCallback(
      ({ currentLocation, nextLocation }: { currentLocation: { pathname: string }; nextLocation: { pathname: string } }) =>
        enabled && currentLocation.pathname !== nextLocation.pathname && hasUnsavedWork(store.getState()),
      [enabled, store],
    ),
  );

  const flush = useCallback(() => (enabled ? controller.flush() : Promise.resolve<FlushOutcome>('skipped')), [
    controller,
    enabled,
  ]);

  const retry = useCallback(() => {
    store.getState().setSave({ status: 'dirty', error: null });
    controller.resume();
    void controller.flush();
  }, [controller, store]);

  /**
   * 网络恢复后自动补存（验收标准 4：断网编辑 30 秒，恢复后内容自动落盘）。
   *
   * 退避重试三次大约 7 秒就放弃了，而用户断网可能持续几分钟——指望退避撑到
   * 网络回来是不现实的。浏览器会在链路恢复时发 `online`，这是唯一可靠的信号。
   *
   * 这里不区分「刚才失败过」和「一直没发出去」：只要还有未落盘的内容就存一次，
   * 状态机自己会用「文档没变」的闸门挡掉多余请求。
   */
  useEffect(() => {
    if (!enabled) return undefined;
    const onOnline = () => {
      const status = store.getState().save.status;
      if (status === 'error' || status === 'dirty') {
        controller.resume();
        void controller.flush();
      }
    };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [enabled, store, controller]);

  const overwrite = useCallback(async () => {
    const current = store.getState().save.conflict;
    if (!current) return;
    setResolving(true);
    try {
      // 拿服务器的版本号重发：这是「我确认覆盖」的表达方式，而不是关掉乐观锁。
      store.getState().setVersion(current.version);
      store.getState().setSave({ status: 'dirty', error: null, conflict: null });
      controller.resume();
      setConflict(null);
      await controller.flush();
    } finally {
      setResolving(false);
    }
  }, [controller, store]);

  const reload = useCallback(async () => {
    setResolving(true);
    try {
      const detail = await mapApi.get(uid);
      store.getState().loadDocument(detail.document);
      store.getState().setVersion(detail.version);
      // 刚拉下来的就是服务端版本，别把它当成「待保存的改动」再存回去。
      controller.markClean();
      clearDraft(uid);
      setConflict(null);
    } catch (error) {
      store.getState().setSave({ status: 'conflict', error: messageOf(error) });
    } finally {
      setResolving(false);
    }
  }, [controller, store, uid]);

  const saveAsCopy = useCallback(async () => {
    setResolving(true);
    try {
      const state = store.getState();
      const copy = await mapApi.create({
        title: `${state.doc.title} - ${i18n.t('editor.duplicateSuffix')}`,
        document: state.doc,
      });
      // 内容已经安全落到新导图上：把状态标成已保存，路由拦截才不会拦自己。
      state.setSave({ status: 'saved', at: Date.now(), error: null, conflict: null });
      clearDraft(uid);
      setConflict(null);
      navigate(`/maps/${copy.uid}`, { replace: true });
    } catch (error) {
      store.getState().setSave({ status: 'conflict', error: messageOf(error) });
    } finally {
      setResolving(false);
    }
  }, [navigate, store, uid]);

  const stay = useCallback(() => {
    if (blocker.state === 'blocked') blocker.reset();
  }, [blocker]);

  const leave = useCallback(() => {
    const state = store.getState();
    if (hasUnsavedWork(state)) writeDraft({ uid, document: state.doc, savedAt: Date.now() });
    if (blocker.state === 'blocked') blocker.proceed();
  }, [blocker, store, uid]);

  return {
    flush,
    retry,
    conflict,
    overwrite,
    reload,
    saveAsCopy,
    resolving,
    blocked: blocker.state === 'blocked',
    stay,
    leave,
  };
}

/** 打开导图时检查是否有比服务端更新的本地草稿。 */
export function pickDraftToRestore(uid: string, serverUpdatedAt: string, serverDocument: WmindDocument): LocalDraft | null {
  const draft = readDraft(uid);
  if (!draft) return null;
  const serverTime = Date.parse(serverUpdatedAt);
  if (!Number.isFinite(serverTime) || draft.savedAt <= serverTime) return null;
  // 内容一样就没必要问：「恢复」的结果和「不恢复」一样，弹窗纯属打扰。
  if (JSON.stringify(draft.document) === JSON.stringify(serverDocument)) {
    clearDraft(uid);
    return null;
  }
  return draft;
}
