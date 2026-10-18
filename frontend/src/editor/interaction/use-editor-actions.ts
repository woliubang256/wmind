/**
 * 键盘动作 → 命令派发。
 *
 * 这一层是「键位表」与「命令」之间的粘合剂：`resolveKey` 只说是哪个动作，
 * 这里决定动作落到哪个命令、作用在哪个节点上。
 *
 * 所有状态都通过 `store.getState()` 现取，不用渲染期闭包里的值。原因很直接：
 * 一次连按（比如连按 5 次 Tab）里，回调如果读到的是首次渲染的 `selection`，
 * 后 4 次会全部加到同一个父节点下。渲染期闭包在 React 里看起来总是「对的」，
 * 直到用户按得快了一点。
 */

import { useCallback, useMemo } from 'react';
import type { LayoutResult } from '../layout/types';
import type { Sheet, Topic } from '../model/types';
import { findTopicInSheet, siblingList } from '../model/traverse';
import { useEditorStoreApi } from '../store/use-editor';
import {
  addChildCommand,
  addSiblingCommand,
  pasteTopicsCommand,
  removeTopicsCommand,
} from '../commands/topic';
import { geometricNeighbor, structuralNeighbor } from './navigation';
import { copyToClipboard, hasClipboardContent, readClipboard } from './clipboard';
import type { HotkeyHandlers } from './hotkeys';

export interface EditorActionDeps {
  layout: LayoutResult;
  sheet: Sheet;
  /** 缩放到 100%（Ctrl+0）。 */
  onResetZoom?(): void;
  /** 缩放到适应（Ctrl+1）。 */
  onFit?(): void;
  /** 立即保存（Ctrl+S）。M2.6 接入自动保存后换成真正的 flush。 */
  onSave?(): void;
}

export function useEditorActions({
  layout,
  sheet,
  onResetZoom,
  onFit,
  onSave,
}: EditorActionDeps): HotkeyHandlers {
  const store = useEditorStoreApi();

  /** 当前操作对象：有选中用选中，没选中就当根节点。 */
  const activeId = useCallback(() => {
    const state = store.getState();
    return state.selection[0] ?? sheet.rootTopic.id;
  }, [store, sheet]);

  const selectedTopics = useCallback((): Topic[] => {
    const state = store.getState();
    return state.selection
      .map((id) => findTopicInSheet(sheet, id)?.topic)
      .filter((topic): topic is Topic => Boolean(topic));
  }, [store, sheet]);

  return useMemo<HotkeyHandlers>(() => {
    const move = (id: string | null) => {
      if (id) store.getState().select([id]);
    };

    return {
      'topic.add-child': () => {
        store.getState().dispatch(addChildCommand(activeId()));
      },
      'topic.add-sibling': () => {
        store.getState().dispatch(addSiblingCommand(activeId()));
      },
      'topic.edit': () => {
        store.getState().setEditing(activeId());
      },
      'topic.delete': () => {
        const selection = store.getState().selection;
        if (selection.length === 0) return;
        store.getState().dispatch(removeTopicsCommand(selection));
      },

      'select.all': () => {
        const ids = siblingList(sheet, activeId()).map((topic) => topic.id);
        store.getState().select(ids);
      },
      'select.clear': () => {
        store.getState().clearSelection();
      },

      'nav.up': () => move(geometricNeighbor(layout.boxes, activeId(), 'up')),
      'nav.down': () => move(geometricNeighbor(layout.boxes, activeId(), 'down')),
      'nav.left': () => move(geometricNeighbor(layout.boxes, activeId(), 'left')),
      'nav.right': () => move(geometricNeighbor(layout.boxes, activeId(), 'right')),

      'nav.parent': () => move(structuralNeighbor(sheet, activeId(), 'parent')),
      'nav.child': () => move(structuralNeighbor(sheet, activeId(), 'child')),
      'nav.prev-sibling': () => move(structuralNeighbor(sheet, activeId(), 'prev-sibling')),
      'nav.next-sibling': () => move(structuralNeighbor(sheet, activeId(), 'next-sibling')),

      'history.undo': () => store.getState().undo(),
      'history.redo': () => store.getState().redo(),

      'clipboard.copy': () => {
        copyToClipboard(selectedTopics());
      },
      'clipboard.cut': () => {
        const topics = selectedTopics();
        if (topics.length === 0) return;
        copyToClipboard(topics);
        store.getState().dispatch(removeTopicsCommand(store.getState().selection));
      },
      'clipboard.paste': () => {
        if (!hasClipboardContent()) return;
        store.getState().dispatch(pasteTopicsCommand(activeId(), readClipboard()));
      },

      'view.reset': () => onResetZoom?.(),
      'view.fit': () => onFit?.(),
      'doc.save': () => onSave?.(),
    };
  }, [store, sheet, layout, activeId, selectedTopics, onResetZoom, onFit, onSave]);
}
