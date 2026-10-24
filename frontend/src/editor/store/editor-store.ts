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
import type { CanvasView, WmindDocument } from '../model/types';
import { isCanvasView, parseViewState } from '../model/view-state';
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
  /** 冲突时服务器的版本号与更新时间；`status === 'conflict'` 时才有值。 */
  conflict: { version: number; updatedAt: string | null } | null;
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
  /**
   * 服务器端的乐观锁版本号。
   *
   * 放在 store 里而不是自动保存的闭包里：版本号是「这份文档的身份」的一部分，
   * 撤销、重做、冲突覆盖都要读它，而闭包只有自动保存看得见。本地新建
   * （演示文档 / 压测文档）时为 0，表示「还没有对应的服务器记录」。
   */
  version: number;
  /** 整份文档重载代次；同画布也须丢弃之前的视口缓存。 */
  documentLoadGeneration: number;
  lastCommand: { type: string; key: string | null; at: number } | null;

  dispatch(command: EditorCommand): void;
  undo(): void;
  redo(): void;

  select(ids: readonly string[]): void;
  toggleSelect(id: string): void;
  clearSelection(): void;
  setEditing(id: string | null): void;

  /**
   * 切换当前画布。
   *
   * 不是命令、不进历史，但当前画布随视图自动保存。切过去必须清空
   * 选中与编辑态——选中记的是节点 id，属于上一张画布，留着会让下一张画布
   * 上同 id 的节点莫名其妙高亮（导入的文档里跨画布同 id 完全可能）。
   * 撤销 / 重做会把 `sheetId` 一起还原（见 HistoryEntry），所以切画布之后
   * 按 ⌘Z 撤销的仍是画布上的编辑，而不是「切回来」这一步。
   */
  setSheet(sheetId: string): void;

  setViewport(viewport: Viewport): void;
  /** 主动导航需要保存，但不进入内容撤销栈。 */
  saveCanvasView(sheetId: string, view: CanvasView): void;
  setSave(patch: Partial<SaveState>): void;

  /**
   * 保存成功。
   *
   * `revisionAtStart` 是**发起保存时**的 revision：请求往返期间用户可能又敲了
   * 几个字，此时文档已经比刚存上去的那份新。无条件置成 `saved` 会让界面显示
   * 「已保存」而实际有未落盘的改动，下一次编辑前的窗口期里刷新就丢了。
   */
  markSaved(version: number, revisionAtStart: number): void;

  /** 收到 409：记下服务器版本，等用户选怎么处理。 */
  markConflict(version: number, updatedAt: string | null): void;

  setVersion(version: number): void;

  /** 整份替换（导入 / 从模板创建 / 放弃本地修改），会清空历史。 */
  loadDocument(doc: WmindDocument): void;
}

export interface EditorStoreOptions {
  doc: WmindDocument;
  sheetId?: string;
  /** 服务器版本号。本地文档（演示 / 压测）不传，视作 0。 */
  version?: number;
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

/**
 * 编辑之后的状态。
 *
 * 冲突未处理时**保持 `conflict` 不变**：用户可能没注意对话框又继续编辑，
 * 若这里把状态打回 `dirty`，自动保存会立刻再发一次请求、再撞一次 409，
 * 对话框反复弹出——而用户其实还没决定要怎么处理。
 */
function dirtySave(previous: SaveState): SaveState {
  if (previous.status === 'conflict') return previous;
  return { status: 'dirty', at: previous.at, error: null, conflict: null };
}

export function createEditorStore(options: EditorStoreOptions): StoreApi<EditorState> {
  const historyLimit = options.historyLimit ?? DEFAULT_HISTORY_LIMIT;
  const coalesceWindowMs = options.coalesceWindowMs ?? DEFAULT_COALESCE_WINDOW_MS;
  const now = options.now ?? (() => Date.now());
  const nextId = options.nextId ?? newTopicId;

  const initialSheet = options.sheetId ?? parseViewState(options.doc.viewState, options.doc.sheets.map((sheet) => sheet.id))?.activeSheetId ?? firstSheet(options.doc).id;

  const restoreHistory = (doc: WmindDocument, current: WmindDocument, activeSheetId: string): WmindDocument => {
    if (!current.viewState && !doc.viewState) return doc;
    // 已删除画布的视角只能从历史快照找回；仍存在的画布则保留最新导航。
    const viewState = parseViewState({
      activeSheetId,
      sheets: { ...doc.viewState?.sheets, ...current.viewState?.sheets },
    }, doc.sheets.map((sheet) => sheet.id));
    return { ...doc, viewState };
  };

  return createStore<EditorState>((set, get) => ({
    doc: options.doc,
    sheetId: initialSheet,
    selection: [],
    editingId: null,
    viewport: { x: 0, y: 0, zoom: 1 },
    past: [],
    future: [],
    save: { status: 'idle', at: null, error: null, conflict: null },
    revision: 0,
    version: options.version ?? 0,
    documentLoadGeneration: 0,
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
        save: dirtySave(state.save),
        lastCommand: { type: command.type, key, at },
      });
    },

    undo(): void {
      const state = get();
      const entry = state.past[state.past.length - 1];
      if (!entry) return;
      set({
        doc: restoreHistory(entry.doc, state.doc, entry.sheetId),
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
        save: dirtySave(state.save),
      });
    },

    redo(): void {
      const state = get();
      const entry = state.future[state.future.length - 1];
      if (!entry) return;
      set({
        doc: restoreHistory(entry.doc, state.doc, entry.sheetId),
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
        save: dirtySave(state.save),
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

    setSheet(sheetId: string): void {
      const state = get();
      if (state.sheetId === sheetId) return;
      // 不存在的 id 直接忽略：删掉当前画布之后调用方可能拿着旧 id 再切一次，
      // 那时静默失败比抛错合适——界面已经渲染出第一张画布了。
      if (!state.doc.sheets.some((sheet) => sheet.id === sheetId)) return;
      const doc = produce(state.doc, (draft) => {
        draft.viewState = { activeSheetId: sheetId, sheets: draft.viewState?.sheets ?? {} };
      });
      set({ doc, sheetId, selection: [], editingId: null, revision: state.revision + 1, save: dirtySave(state.save) });
    },

    setViewport(viewport: Viewport): void {
      set({ viewport });
    },

    saveCanvasView(sheetId: string, view: CanvasView): void {
      const state = get();
      if (!isCanvasView(view) || !state.doc.sheets.some((sheet) => sheet.id === sheetId)) return;
      const previous = state.doc.viewState?.sheets[sheetId];
      if (previous && previous.centerX === view.centerX && previous.centerY === view.centerY && previous.zoom === view.zoom) return;
      const doc = produce(state.doc, (draft) => {
        draft.viewState ??= { activeSheetId: state.sheetId, sheets: {} };
        draft.viewState.activeSheetId = state.sheetId;
        draft.viewState.sheets[sheetId] = { ...view };
      });
      set({ doc, revision: state.revision + 1, save: dirtySave(state.save) });
    },

    setSave(patch: Partial<SaveState>): void {
      set({ save: { ...get().save, ...patch } });
    },

    markSaved(version: number, revisionAtStart: number): void {
      const state = get();
      // 请求往返期间又编辑过 → 仍然是 dirty。但版本号必须采纳：这次保存
      // 已经落盘并自增了版本，继续用旧版本号发下一次请求会立刻 409。
      const stillDirty = state.revision !== revisionAtStart;
      set({
        version,
        save: {
          status: stillDirty ? 'dirty' : 'saved',
          at: now(),
          error: null,
          conflict: null,
        },
      });
    },

    markConflict(version: number, updatedAt: string | null): void {
      set({
        save: { status: 'conflict', at: get().save.at, error: null, conflict: { version, updatedAt } },
      });
    },

    setVersion(version: number): void {
      set({ version });
    },

    loadDocument(doc: WmindDocument): void {
      // 冲突重载直接安装 API 文档，不经过首屏 parseDocument；这里也须守住视图边界。
      const viewState = parseViewState(doc.viewState, doc.sheets.map((sheet) => sheet.id));
      const normalized = { ...doc };
      if (viewState) normalized.viewState = viewState;
      else delete normalized.viewState;
      set({
        doc: normalized,
        documentLoadGeneration: get().documentLoadGeneration + 1,
        sheetId: viewState?.activeSheetId ?? firstSheet(doc).id,
        selection: [],
        editingId: null,
        past: [],
        future: [],
        lastCommand: null,
        revision: 0,
        save: { status: 'idle', at: null, error: null, conflict: null },
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
