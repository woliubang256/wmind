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
import type { ComputedStyle, Sheet, Topic } from '../model/types';
import { findTopicInSheet, siblingList } from '../model/traverse';
import { useEditorStoreApi } from '../store/use-editor';
import {
  addChildCommand,
  addSiblingCommand,
  pasteTopicsCommand,
  removeTopicsCommand,
  toggleCollapseCommand,
} from '../commands/topic';
import { nextFillColor, updateStyleCommand } from '../commands/style';
import { resolveStyle } from '../theme/resolve';
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
  onDeleteSelection?(): void;
  onClearSelection?(): void;
}

export function useEditorActions({
  layout,
  sheet,
  onResetZoom,
  onFit,
  onSave,
  onDeleteSelection,
  onClearSelection,
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

  /**
   * 样式命令的作用对象：有选中就整批作用，没选中就落在「当前节点」上。
   *
   * 与 Tab / Enter 的口径保持一致。不一致的话，空选中时按 ⌘+B 会静默无反应，
   * 用户只会以为快捷键坏了。
   */
  const styleTargets = useCallback((): string[] => {
    const state = store.getState();
    return state.selection.length > 0 ? [...state.selection] : [activeId()];
  }, [store, activeId]);

  /**
   * 节点的**最终**样式（含主题、角色、调色板、节点自定义四层）。
   *
   * 加粗 / 变色的开关必须基于「看起来是什么样」判断：一级分支的填充色是渲染期
   * 按 `branchIndex` 算出来的，`topic.style.fill` 通常是 null；按显式字段判断
   * 会让第一颗按键看起来毫无反应。
   */
  const computedStyle = useCallback((id: string): ComputedStyle | null => {
    const found = findTopicInSheet(sheet, id);
    if (!found) return null;
    return resolveStyle(
      found.topic,
      {
        depth: found.depth,
        branchIndex: found.branchIndex,
        isRoot: found.parent === null && !found.isFloating,
        isFloating: found.isFloating,
        isSummary: false,
      },
      store.getState().doc.theme,
    );
  }, [sheet, store]);

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
        if (onDeleteSelection) { onDeleteSelection(); return; }
        const selection = store.getState().selection;
        if (selection.length === 0) return;
        store.getState().dispatch(removeTopicsCommand(selection));
      },
      'topic.toggle-collapse': () => {
        store.getState().dispatch(toggleCollapseCommand(activeId()));
      },

      'select.all': () => {
        const ids = siblingList(sheet, activeId()).map((topic) => topic.id);
        store.getState().select(ids);
      },
      'select.clear': () => {
        store.getState().clearSelection();
        onClearSelection?.();
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

      'style.bold': () => {
        const ids = styleTargets();
        const current = computedStyle(ids[0] ?? '');
        if (!current) return;
        // 中心主题的角色样式本来就是 700，所以「取消加粗」是降到 400，
        // 而不是清空字段——显式 400 与「继承到的 700」在视觉上确实不同。
        store.getState().dispatch(
          updateStyleCommand(ids, { fontWeight: current.fontWeight >= 700 ? 400 : 700 }),
        );
      },
      'style.cycle-fill': () => {
        const ids = styleTargets();
        const current = computedStyle(ids[0] ?? '');
        if (!current) return;
        store.getState().dispatch(
          updateStyleCommand(ids, { fill: nextFillColor(store.getState().doc.theme, current.fill) }),
        );
      },

      'view.reset': () => onResetZoom?.(),
      'view.fit': () => onFit?.(),
      'doc.save': () => onSave?.(),
    };
  }, [store, sheet, layout, activeId, selectedTopics, styleTargets, computedStyle, onResetZoom, onFit, onSave, onDeleteSelection, onClearSelection]);
}
