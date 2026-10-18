/**
 * 编辑器 store（vanilla zustand，不依赖 React）。
 *
 * 拆成 vanilla store 的理由：内核层要能在没有 DOM 的单元测试里跑，
 * 而 `zustand` 的 `create` 会在调用 hook 时触碰 React。React 绑定单独放在
 * `use-editor.ts` 里。
 *
 * 每张打开的导图一个 store 实例，不做全局单例：全局单例在测试里会互相污染，
 * 在应用里会让「同时打开两个标签页」之外的场景（比如预览）无法并存。
 */

import { produce } from 'immer';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { WmindDocument } from '../model/types';
import { firstSheet } from '../model/traverse';
import { newTopicId } from '../model/ids';
import type { CommandContext, CommandResult, EditorCommand } from '../commands/types';

export type SaveStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'error' | 'conflict';

export interface SaveState {
  status: SaveStatus;
  /** 最近一次成功保存的时间戳。 */
  at: number | null;
  /** 失败原因，直接展示给用户。 */
  error: string | null;
}

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

export interface HistoryEntry {
  /** 产生**下一个**状态的那条命令的文案；撤销 / 重做提示都用它。 */
  label: string;
  doc: WmindDocument;
  selection: string[];
  sheetId: string;
  at: number;
}

export interface EditorState {
  doc: WmindDocument;
  sheetId: string;
  selection: string[];
  editingId: string | null;
  viewport: Viewport;
  past: HistoryEntry[];
  future: HistoryEntry[];
  save: SaveState;
  /** 文档变更计数。自动保存用它做「自上次保存后是否有变化」的判断。 */
  revision: number;
  lastCommand: { type: string; key: string | null; at: number } | null;

  dispatch(command: EditorCommand): void;
  undo(): void;
  redo(): void;

  select(ids: readonly string[]): void;
  toggleSelect(id: string): void;
  clearSelection(): void;
  setEditing(id: string | null): void;

  setViewport(viewport: Viewport): void;
  setSave(patch: Partial<SaveState>): void;

  /** 整份替换（导入 / 从模板创建），会清空历史。 */
  loadDocument(doc: WmindDocument): void;
}

export interface EditorStoreOptions {
  doc: WmindDocument;
  sheetId?: string;
  /** 历史栈上限。默认 200（docs/05 §4.7）。 */
  historyLimit?: number;
  /** 连续同类命令的合并窗口。默认 800ms。 */
  coalesceWindowMs?: number;
  /** 时间源，测试可注入。 */
  now?: () => number;
  /** id 生成器，测试可注入确定性实现。 */
  nextId?: () => string;
}

export const DEFAULT_HISTORY_LIMIT = 200;
export const DEFAULT_COALESCE_WINDOW_MS = 800;

export function createEditorStore(options: EditorStoreOptions): StoreApi<EditorState> {
  const historyLimit = options.historyLimit ?? DEFAULT_HISTORY_LIMIT;
  const coalesceWindowMs = options.coalesceWindowMs ?? DEFAULT_COALESCE_WINDOW_MS;
  const now = options.now ?? (() => Date.now());
  const nextId = options.nextId ?? newTopicId;

  const initialSheet = options.sheetId ?? firstSheet(options.doc).id;

  return createStore<EditorState>((set, get) => ({
    doc: options.doc,
    sheetId: initialSheet,
    selection: [],
    editingId: null,
    viewport: { x: 0, y: 0, zoom: 1 },
    past: [],
    future: [],
    save: { status: 'idle', at: null, error: null },
    revision: 0,
    lastCommand: null,

    dispatch(command: EditorCommand): void {
      const state = get();
      const at = now();
      const ctx: CommandContext = { sheetId: state.sheetId, now: at, nextId };

      // 用可变容器接 apply 的返回值，而不是 `let result`：TS 的控制流分析
      // 看不到回调内部的赋值，会把它窄化成 undefined（`never` 报错）。
      const outcome: { result?: CommandResult } = {};
      const applied = produce(state.doc, (draft) => {
        outcome.result = command.apply(draft, ctx) ?? undefined;
      });

      // immer 在 recipe 未做任何修改时返回原引用。用它判断空操作：
      // 空操作不进历史，否则撤销栈里会堆满「按了但什么都没发生」的记录。
      if (applied === state.doc) return;

      // meta.updatedAt 单独一次 produce：如果和 apply 放同一个 recipe，
      // 每次命令都会改动 meta，空操作检测就永远失效了。
      const nextDoc = produce(applied, (draft) => {
        draft.meta.updatedAt = new Date(at).toISOString();
      });

      const previous = state.lastCommand;
      const key = command.coalesceKey ?? null;
      const canCoalesce =
        key !== null &&
        previous !== null &&
        previous.type === command.type &&
        previous.key === key &&
        at - previous.at <= coalesceWindowMs;

      const snapshot: HistoryEntry = {
        label: command.label,
        doc: state.doc,
        selection: state.selection,
        sheetId: state.sheetId,
        at,
      };
      const past = canCoalesce
        ? state.past
        : [...state.past, snapshot].slice(-historyLimit);

      const selected = outcome.result?.select;
      set({
        doc: nextDoc,
        past,
        future: [],
        selection: selected ?? state.selection,
        editingId: outcome.result?.edit ? (selected?.[0] ?? null) : null,
        revision: state.revision + 1,
        save: { status: 'dirty', at: state.save.at, error: null },
        lastCommand: { type: command.type, key, at },
      });
    },

    undo(): void {
      const state = get();
      const entry = state.past[state.past.length - 1];
      if (!entry) return;
      set({
        doc: entry.doc,
        selection: entry.selection,
        sheetId: entry.sheetId,
        past: state.past.slice(0, -1),
        future: [
          ...state.future,
          {
            label: entry.label,
            doc: state.doc,
            selection: state.selection,
            sheetId: state.sheetId,
            at: now(),
          },
        ],
        // 清掉合并状态：撤销之后再打字，不该和撤销前的那次输入合并成一条历史。
        lastCommand: null,
        editingId: null,
        revision: state.revision + 1,
        save: { status: 'dirty', at: state.save.at, error: null },
      });
    },

    redo(): void {
      const state = get();
      const entry = state.future[state.future.length - 1];
      if (!entry) return;
      set({
        doc: entry.doc,
        selection: entry.selection,
        sheetId: entry.sheetId,
        past: [...state.past, {
          label: entry.label,
          doc: state.doc,
          selection: state.selection,
          sheetId: state.sheetId,
          at: now(),
        }].slice(-historyLimit),
        future: state.future.slice(0, -1),
        lastCommand: null,
        editingId: null,
        revision: state.revision + 1,
        save: { status: 'dirty', at: state.save.at, error: null },
      });
    },

    select(ids: readonly string[]): void {
      set({ selection: [...ids] });
    },

    toggleSelect(id: string): void {
      const state = get();
      set({
        selection: state.selection.includes(id)
          ? state.selection.filter((s) => s !== id)
          : [...state.selection, id],
      });
    },

    clearSelection(): void {
      set({ selection: [] });
    },

    setEditing(id: string | null): void {
      set({ editingId: id });
    },

    setViewport(viewport: Viewport): void {
      set({ viewport });
    },

    setSave(patch: Partial<SaveState>): void {
      set({ save: { ...get().save, ...patch } });
    },

    loadDocument(doc: WmindDocument): void {
      set({
        doc,
        sheetId: firstSheet(doc).id,
        selection: [],
        editingId: null,
        past: [],
        future: [],
        lastCommand: null,
        revision: 0,
        save: { status: 'idle', at: null, error: null },
      });
    },
  }));
}

export type EditorStore = StoreApi<EditorState>;

/** 选择器：能否撤销 / 重做。放在这里而不是 state 上，避免每次 set 都要重算。 */
export function canUndo(state: EditorState): boolean {
  return state.past.length > 0;
}

export function canRedo(state: EditorState): boolean {
  return state.future.length > 0;
}
