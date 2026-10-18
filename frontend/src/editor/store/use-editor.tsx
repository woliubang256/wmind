/**
 * store 的 React 绑定。
 *
 * 内核 store 是 vanilla 的（见 editor-store.ts 顶部说明），这里只做三件事：
 * 用 context 分发实例、用 `useStore` 做选择器订阅、把「没有 Provider」
 * 变成一句能看懂的报错。
 */

import { createContext, useContext, type ReactNode } from 'react';
import { useStore } from 'zustand';
import type { EditorState, EditorStore } from './editor-store';

const EditorContext = createContext<EditorStore | null>(null);

export function EditorProvider({ store, children }: { store: EditorStore; children: ReactNode }) {
  return <EditorContext.Provider value={store}>{children}</EditorContext.Provider>;
}

export function useEditorStoreApi(): EditorStore {
  const store = useContext(EditorContext);
  if (!store) throw new Error('编辑器组件必须包在 <EditorProvider> 里');
  return store;
}

/**
 * 按选择器订阅。
 *
 * 选择器必须返回稳定值（原始类型或引用不变的派生值）。返回新对象会让
 * zustand v5 在每次 set 后都判定「变了」并重渲染——需要组合多个字段时，
 * 用 `useShallow` 或分别订阅。
 */
export function useEditor<T>(selector: (state: EditorState) => T): T {
  return useStore(useEditorStoreApi(), selector);
}
