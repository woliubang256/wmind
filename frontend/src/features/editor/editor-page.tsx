/**
 * 编辑器页面。
 *
 * 文档来源有两条路：
 *
 * - `/maps/stress` → 本地生成的 2000 节点压测文档，不连后端（验收标准 3）；
 * - `/maps/:uid` → 从 `GET /maps/:uid` 拉取，落盘走自动保存（M2.6）。
 *
 * 页面主体（`Workspace`）对两者是同一套代码，区别只在 `enabled`：自动保存、
 * 本地草稿、离开保护在本地文档上没有意义，硬挂上去只会每 800ms 撞一次 404。
 *
 * 这一层负责四件事：
 *
 * 1. 持有视口——「缩放到适应」既要知道容器尺寸又要写视口，让查看器自己管
 *    的话工具栏就拿不到写入口；
 * 2. 把 store 与查看器接起来（选中 / 折叠 / 编辑回写）；
 * 3. 把键盘动作接到命令上（见 `useEditorActions`）；
 * 4. 持久化：加载、自动保存、冲突、草稿、离开保护（见 `persistence/`）。
 *
 * 查看器本身不含任何交互：它拿到的是插件列表，只读预览时换一批插件即可。
 */

import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { countNodes, sheetById } from '@/editor/model/traverse';
import { parseDocument } from '@/editor/model/validate';
import { createEditorStore } from '@/editor/store/editor-store';
import { EditorProvider, useEditor, useEditorStoreApi } from '@/editor/store/use-editor';
import { layoutMindmap } from '@/editor/layout/mindmap';
import type { LayoutResult } from '@/editor/layout/types';
import { MIN_ZOOM, zoomedViewport } from '@/editor/viewer/plugins/pan-zoom';
import { EDITOR_PLUGINS, READ_ONLY_PLUGINS } from '@/editor/viewer/plugins';
import { MindMapViewer } from '@/editor/viewer/mind-map-viewer';
import type { Viewport } from '@/editor/viewer/viewer-types';
import type { StructureClass } from '@/editor/model/types';
import type { Style, Theme } from '@/editor/model/types';
import {
  applyThemeCommand,
  resetStyleCommand,
  updateStyleCommand,
} from '@/editor/commands/style';
import { CanvasPanel, type PanelTab } from './panel/canvas-panel';
import { StyleTab } from './panel/style-tab';
import { PaletteTab } from './panel/palette-tab';
import { useHotkeys } from '@/editor/interaction/hotkeys';
import { isTextEntryTarget } from '@/editor/interaction/keymap';
import { useEditorActions } from '@/editor/interaction/use-editor-actions';
import {
  addChildCommand,
  detachTopicsCommand,
  moveTopicsCommand,
  removeTopicsCommand,
  renameTopicCommand,
  toggleCollapseCommand,
} from '@/editor/commands/topic';
import { changeStructureCommand, changeTitleCommand } from '@/editor/commands/document';
import { mapApi, type MapDetail } from '@/lib/api/maps';
import { ApiError } from '@/lib/api/errors';
import { createDemoDocument, createStressDocument } from './demo-document';
import { useAutosave, pickDraftToRestore } from './persistence/use-autosave';
import { clearDraft, pruneDrafts, type LocalDraft } from './persistence/local-draft';
import { ConflictDialog, LeaveDialog } from './persistence/dialogs';
import { SaveIndicator } from './persistence/save-indicator';
import { useFontsReady } from './use-fonts-ready';
import { useThumbnailUpload } from './use-thumbnail-upload';
import { ShareDialog } from '@/features/share/share-dialog';

// 导出对话框是懒加载的：它把 `react-dom/server` 带进包里（序列化 SVG 要用），
// 而绝大多数编辑会话里用户根本不会点「导出」。不点就不下载。
const ExportDialog = lazy(() =>
  import('./export-dialog').then((module) => ({ default: module.ExportDialog })),
);

export function EditorPage() {
  const { uid = '' } = useParams();
  // 两个本地入口，都不连后端：
  // - `/maps/demo`：内置演示文档，用来验证渲染与交互（不需要账号里的数据）；
  // - `/maps/stress`：2000 节点压测文档（验收标准 3）。
  // 它们和真实导图共用同一套页面代码，区别只有「不挂自动保存」。
  if (uid === 'demo') return <LocalEditor uid={uid} kind="demo" />;
  if (uid === 'stress') return <LocalEditor uid={uid} kind="stress" />;
  return <RemoteEditor uid={uid} />;
}

/**
 * 本地文档的编辑器。
 *
 * `kind` 而不是直接传 `doc`：文档对象必须在这里用 `useMemo` 造，否则父组件
 * 每渲染一次就换一份新文档，store 跟着重建——撤销栈和选中状态会被无声清空。
 */
function LocalEditor({ uid, kind }: { uid: string; kind: 'demo' | 'stress' }) {
  const store = useMemo(
    () => createEditorStore({ doc: kind === 'demo' ? createDemoDocument() : createStressDocument(2000) }),
    [kind],
  );
  return (
    <EditorProvider store={store}>
      <Workspace uid={uid} enabled={false} initialDraft={null} initialThumbnailUrl="" />
    </EditorProvider>
  );
}

function RemoteEditor({ uid }: { uid: string }) {
  const { t } = useTranslation();
  const query = useQuery({
    queryKey: ['map', uid],
    queryFn: async () => {
      const detail = await mapApi.get(uid);
      // 服务端只校验 `format` / `sheets` / `rootTopic` 三个字段，剩下的必填项
      // 由这里补全。少了 `theme` 的文档会让字体扫描读 `undefined.global`，
      // 整页变成「Unexpected Application Error」——而这份文档是导入侧归一化
      // 出来的同一个东西，导入能开、重开就白屏，说明中间漏了一道闸门。
      // 与导入共用 `parseDocument`：两处口径必须一致，否则差异迟早变成 bug。
      return { ...detail, document: parseDocument(detail.document).document };
    },
    // 打开失败重试没有意义：404 就是 404，网络断了重试三次也只是让用户多等。
    retry: false,
    // 编辑器里的文档是唯一权威，任何后台刷新都会把用户正在改的内容冲掉。
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  if (query.isPending) {
    return (
      <div className="h-[calc(100svh-9.5rem)] min-h-[420px] overflow-hidden rounded-2xl border border-border/70">
        <EditorSkeleton label={t('editor.loading')} />
      </div>
    );
  }

  if (query.isError) {
    const notFound = query.error instanceof ApiError && query.error.code === 'MAP_NOT_FOUND';
    return (
      <div className="grid h-[calc(100svh-9.5rem)] min-h-[420px] place-items-center rounded-2xl border border-border/70 bg-card px-6 text-center">
        <div className="max-w-sm">
          <span className="mx-auto grid size-12 place-items-center rounded-2xl bg-secondary text-secondary-foreground">
            <Icon name={notFound ? 'files' : 'alert'} className="size-5" />
          </span>
          <h2 className="mt-4 font-semibold">
            {notFound ? t('editor.loadError.notFoundTitle') : t('editor.loadError.title')}
          </h2>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            {notFound ? t('editor.loadError.notFoundBody') : t('editor.loadError.body')}
          </p>
          <div className="mt-4 flex justify-center gap-2">
            {notFound ? null : (
              <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
                {t('editor.loadError.retry')}
              </Button>
            )}
            <Button size="sm" onClick={() => window.history.back()}>
              {t('editor.back')}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return <LoadedEditor detail={query.data} />;
}

function LoadedEditor({ detail }: { detail: MapDetail }) {
  // 每张导图一个 store：切路由时重建，避免上一张图的撤销栈泄漏到下一张。
  const store = useMemo(
    () => createEditorStore({ doc: detail.document, version: detail.version }),
    [detail],
  );
  // 草稿检查只在首次挂载做一次：之后再算会把用户自己刚保存的内容当成「本地修改」。
  const [draft] = useState<LocalDraft | null>(() => {
    pruneDrafts();
    return pickDraftToRestore(detail.uid, detail.updatedAt, detail.document);
  });

  return (
    <EditorProvider store={store}>
      <Workspace
        uid={detail.uid}
        enabled
        initialDraft={draft}
        initialThumbnailUrl={detail.thumbnailUrl}
      />
    </EditorProvider>
  );
}

/**
 * 等字体期间的占位布局。
 *
 * 不能「先按回退字体算一遍、字体到了再重算」：测量缓存以 `字体标识符+文本` 为键，
 * 回退字体量出来的宽度会被永久缓存（`layout/measure.ts`），之后重排也拿不到正确
 * 值。所以字体就绪前**根本不进布局**，先用一个空结果占位。
 */
const PENDING_LAYOUT: LayoutResult = {
  boxes: new Map(),
  edges: [],
  sizes: new Map(),
  styles: new Map(),
  bounds: { x: 0, y: 0, width: 1, height: 1 },
};

/**
 * 骨架屏：等文档、等字体共用。
 *
 * `flex-1` 是必需的：等字体时它是 `flex` 行的子元素，不拉伸就只有内容那么宽，
 * 加载指示器会贴在画布左边缘而不是居中。
 */
function EditorSkeleton({ label }: { label: string }) {
  return (
    <div className="grid h-full min-h-0 flex-1 place-items-center bg-card">
      <div className="flex flex-col items-center gap-3 text-sm text-muted-foreground">
        <span className="size-6 animate-spin rounded-full border-2 border-border border-t-primary" />
        {label}
      </div>
    </div>
  );
}

/** 工具栏里可选的结构。八种都有真实几何，不再有「选了会退回 mindmap」的坑。 */
const STRUCTURES: StructureClass[] = [
  'mindmap',
  'logic-right',
  'logic-left',
  'tree-right',
  'org-chart',
  'timeline',
  'fishbone',
  'brace',
  'tree-table',
];

interface WorkspaceProps {
  uid: string;
  enabled: boolean;
  initialDraft: LocalDraft | null;
  /** 打开时服务端的缩略图地址；空串表示还没有，需要在首帧后生成。 */
  initialThumbnailUrl: string;
}

function Workspace({ uid, enabled, initialDraft, initialThumbnailUrl }: WorkspaceProps) {
  const { t } = useTranslation();
  const store = useEditorStoreApi();
  const doc = useEditor((state) => state.doc);
  const sheetId = useEditor((state) => state.sheetId);
  const selection = useEditor((state) => state.selection);
  const editingId = useEditor((state) => state.editingId);
  const pastCount = useEditor((state) => state.past.length);
  const futureCount = useEditor((state) => state.future.length);
  const saveState = useEditor((state) => state.save);
  const version = useEditor((state) => state.version);

  const [preview, setPreview] = useState(false);
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, zoom: 1 });
  const [draft, setDraft] = useState<LocalDraft | null>(initialDraft);
  const [conflictOpen, setConflictOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);
  const [panelTab, setPanelTab] = useState<PanelTab>('style');
  const [exportOpen, setExportOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  /** 快捷键监听挂在这里：包含画布与面板，但排除侧栏与页头之外的一切。 */
  const rootRef = useRef<HTMLDivElement | null>(null);

  const autosave = useAutosave({ uid, store, enabled });

  // 冲突出现时自动打开对话框。放在 effect 里而不是渲染时判断：用户可能手动
  // 关掉它去核对内容，之后再编辑时不应该被强行再弹一次。
  useEffect(() => {
    if (autosave.conflict) setConflictOpen(true);
  }, [autosave.conflict]);

  const sheet = useMemo(() => sheetById(doc, sheetId), [doc, sheetId]);
  // 字体就绪之前不进布局（见 PENDING_LAYOUT 的注释）。
  const fonts = useFontsReady(doc);
  const layout = useMemo(
    () => (fonts.ready ? layoutMindmap({ sheet, theme: doc.theme }) : PENDING_LAYOUT),
    // generation 参与依赖：换字体族后分片才到齐，得重算一次，否则一直用回退字体
    // 量出来的宽度（见 use-fonts-ready.ts）。
    [sheet, doc.theme, fonts.ready, fonts.generation],
  );
  // 缩略图：首帧后生成一次，之后每次保存成功且距上次超过 3 分钟再生成。
  // 判定逻辑在 `features/maps/thumbnail-plan.ts`，这里只传事实。
  useThumbnailUpload({
    uid,
    enabled,
    document: doc,
    sheetId,
    initialThumbnailUrl,
    version,
    ready: fonts.ready,
  });

  const selectionSet = useMemo(() => new Set(selection), [selection]);

  /**
   * 面板作用对象：有选中就用选中，没有就编辑中心主题。
   *
   * 「没选中时改中心主题」比「没选中时面板整个禁用」有用得多——用户打开一张
   * 新图想先调一下中心主题，不该先学会怎么选中它。多选时批量作用，回显用第一个。
   */
  const panelTargets = useMemo(
    () =>
      (selection.length > 0 ? selection : [sheet.rootTopic.id]).filter((id) => layout.styles.has(id)),
    [selection, sheet.rootTopic.id, layout],
  );
  const panelStyle = panelTargets.length > 0 ? (layout.styles.get(panelTargets[0]!) ?? null) : null;

  const patchStyle = useCallback(
    (patch: Partial<Style>) => {
      if (panelTargets.length === 0) return;
      store.getState().dispatch(updateStyleCommand(panelTargets, patch));
    },
    [panelTargets, store],
  );

  const applyTheme = useCallback(
    (theme: Theme) => store.getState().dispatch(applyThemeCommand(theme)),
    [store],
  );

  const fit = useCallback(() => {
    const element = canvasRef.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const raw = Math.min(rect.width / layout.bounds.width, rect.height / layout.bounds.height) * 0.94;
    const zoom = Math.max(MIN_ZOOM, Math.min(1.2, raw));
    setViewport({
      zoom,
      x: (rect.width - layout.bounds.width * zoom) / 2,
      y: (rect.height - layout.bounds.height * zoom) / 2,
    });
  }, [layout]);

  // 只在挂载与容器尺寸变化时重新适配。用 ref 拿最新的 fit，避免把 fit 放进
  // 依赖数组——否则每敲一个字都会重新适配一次，用户手动缩放的位置会被抢走。
  const fitRef = useRef(fit);
  fitRef.current = fit;
  // 依赖 fonts.ready：骨架屏期间 canvasRef 还是 null，只在挂载时跑一次的话，
  // 字体就绪、画布真正挂上之后就没人观察容器尺寸了。
  useEffect(() => {
    const element = canvasRef.current;
    if (!element) return undefined;
    fitRef.current();
    const observer = new ResizeObserver(() => fitRef.current());
    observer.observe(element);
    return () => observer.disconnect();
  }, [fonts.ready]);

  /**
   * 切换结构后重新适配视野。
   *
   * 结构的几何差别很大：`mindmap` 是横向铺开的，`org-chart` 是竖向铺开的，
   * 同一张图换个结构，包围盒可能宽高互换。不重新适配的话，用户切完看到的是
   * 半棵跑到画布外面的树——而「缩放到适应」是唯一能自己发现这件事的动作。
   *
   * 只在结构变化时触发，不跟着布局走：每敲一个字都重新适配会把用户手动
   * 缩放/平移的位置抢走。
   */
  const structure = sheet.structure;
  const fittedStructure = useRef(structure);
  useEffect(() => {
    if (fittedStructure.current === structure) return;
    fittedStructure.current = structure;
    fitRef.current();
  }, [structure]);

  const zoomAtCenter = (factor: number) => {    const element = canvasRef.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    setViewport((prev) => zoomedViewport(prev, factor, { x: rect.width / 2, y: rect.height / 2 }));
  };

  /** Ctrl+0：回到 100%，以当前视口中心为锚点（和滚轮缩放的手感一致）。 */
  const resetZoom = useCallback(() => {
    const element = canvasRef.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    setViewport((prev) =>
      zoomedViewport(prev, 1 / prev.zoom, { x: rect.width / 2, y: rect.height / 2 }),
    );
  }, []);

  /** Ctrl+S：跳过防抖，立刻落盘。 */
  const save = useCallback(() => {
    void autosave.flush();
  }, [autosave]);

  const actions = useEditorActions({
    layout,
    sheet,
    onFit: fit,
    onResetZoom: resetZoom,
    onSave: save,
  });

  /**
   * 进入编辑时把节点挪进视野。
   *
   * 新建的节点总是挂在一棵子树的末尾，而子树是往右长的——在已经缩放到
   * 适应的画布上按 Tab，新节点的输入框会正好压在右边缘外，用户看到一个
   * 半截的框，不知道该往哪打字。这里只做「平移」，不缩放：缩放会改变
   * 用户当前的视野基准，连续按 Tab 时会一直跳。
   */
  useEffect(() => {
    if (!editingId) return;
    const box = layout.boxes.get(editingId);
    const element = canvasRef.current;
    if (!box || !element) return;
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const padding = 64;

    setViewport((prev) => {
      const left = prev.x + box.x * prev.zoom;
      const top = prev.y + box.y * prev.zoom;
      const right = left + box.width * prev.zoom;
      const bottom = top + box.height * prev.zoom;

      let dx = 0;
      let dy = 0;
      // 右边优先：新节点通常从右侧溢出，先保证右边看得见。
      if (right > rect.width - padding) dx = rect.width - padding - right;
      if (left + dx < padding) dx = padding - left;
      if (bottom > rect.height - padding) dy = rect.height - padding - bottom;
      if (top + dy < padding) dy = padding - top;

      // 没有位移就返回原对象，让 React 跳过重渲染（否则每次布局变化
      // 都会写一次 viewport，滚轮位置被反复重置）。
      if (dx === 0 && dy === 0) return prev;
      return { ...prev, x: prev.x + dx, y: prev.y + dy };
    });
  }, [editingId, layout]);

  // 编辑态整张键位表都关掉：输入框自己处理 Esc / Enter / Shift+Enter / Tab，
  // 导图再插手就会把用户的换行吞成「新建主题」。
  useHotkeys(rootRef, actions, { enabled: !preview && editingId === null });

  /**
   * 挂载后把焦点放到画布上。
   *
   * 验收标准 1 要求「全程不碰鼠标」。焦点如果停在 body 上，第一颗 Tab 会去
   * 页头按钮，用户得连按若干次才能开始编辑——键盘用户第一步就卡住了。
   * 打开即聚焦，刷新之后 ⌘+Z 这类快捷键也立刻可用。
   *
   * 只读模式不抢焦点：分享页里把焦点从链接上抢走会让屏幕阅读器丢失阅读位置。
   */
  useEffect(() => {
    if (preview || !fonts.ready) return;
    canvasRef.current?.focus({ preventScroll: true });
  }, [preview, fonts.ready]);

  const activeId = selection[0] ?? sheet.rootTopic.id;

  const restoreDraft = () => {
    if (!draft) return;
    store.getState().loadDocument(draft.document);
    setDraft(null);
    // 恢复出来的内容立刻存一次：用户点「恢复」的意图就是「把这份内容留下」，
    // 让它再等 800ms 防抖只是给了个丢它的机会。
    void autosave.flush();
  };

  const discardDraft = () => {
    clearDraft(uid);
    setDraft(null);
  };

  return (
    <div
      ref={rootRef}
      className="flex h-[calc(100svh-9.5rem)] min-h-[420px] flex-col overflow-hidden rounded-2xl border border-border/70 bg-card"
    >
      <header className="flex flex-wrap items-center gap-2 border-b border-border/70 px-3 py-2">
        <Link
          to="/"
          aria-label={t('editor.back')}
          className="inline-flex size-10 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          <Icon name="chevron-left" className="size-4" />
        </Link>

        <input
          value={doc.title}
          aria-label={t('editor.titlePlaceholder')}
          onChange={(event) => store.getState().dispatch(changeTitleCommand(event.target.value))}
          className="min-w-0 flex-1 rounded-md bg-transparent px-2 py-1 text-sm font-semibold outline-none hover:bg-muted focus:bg-muted"
        />

        {preview ? (
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
            {t('editor.readOnly')}
          </span>
        ) : null}

        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('editor.undo')}
            disabled={pastCount === 0}
            onClick={() => store.getState().undo()}
          >
            <Icon name="undo" className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('editor.redo')}
            disabled={futureCount === 0}
            onClick={() => store.getState().redo()}
          >
            <Icon name="redo" className="size-4" />
          </Button>
        </div>

        {!preview ? (
          <div className="flex items-center gap-0.5">
            <Button
              variant="ghost"
              size="icon"
              aria-label={t('editor.addChild')}
              onClick={() => store.getState().dispatch(addChildCommand(activeId))}
            >
              <Icon name="plus" className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t('editor.delete')}
              disabled={selection.length === 0}
              onClick={() => store.getState().dispatch(removeTopicsCommand(selection))}
            >
              <Icon name="trash" className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t('editor.collapse')}
              disabled={selection.length !== 1}
              onClick={() => store.getState().dispatch(toggleCollapseCommand(selection[0] ?? ''))}
            >
              <Icon name="chevron-right" className="size-4" />
            </Button>
          </div>
        ) : null}

        <div className="flex items-center gap-0.5">
          <Button variant="ghost" size="icon" aria-label={t('editor.zoomOut')} onClick={() => zoomAtCenter(1 / 1.2)}>
            <Icon name="zoom-out" className="size-4" />
          </Button>
          <Button variant="ghost" size="icon" aria-label={t('editor.zoomIn')} onClick={() => zoomAtCenter(1.2)}>
            <Icon name="zoom-in" className="size-4" />
          </Button>
          <Button variant="ghost" size="icon" aria-label={t('editor.fit')} onClick={fit}>
            <Icon name="maximize" className="size-4" />
          </Button>
        </div>

        {/*
          结构切换。用原生 <select>：一共四个选项，为它引入一个下拉组件
          （焦点陷阱、键盘导航、定位）不划算，而原生控件在键盘与读屏上
          本来就是最好的。
        */}
        {!preview ? (
          <select
            aria-label={t('editor.structure')}
            value={sheet.structure}
            onChange={(event) =>
              store.getState().dispatch(changeStructureCommand(event.target.value as StructureClass))
            }
            className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground"
          >
            {STRUCTURES.map((value) => (
              <option key={value} value={value}>
                {t(`editor.structures.${value}`)}
              </option>
            ))}
          </select>
        ) : null}

        {!preview ? (
          <Button
            variant="ghost"
            size="icon"
            aria-label={panelOpen ? t('editor.panel.hide') : t('editor.panel.show')}
            aria-pressed={panelOpen}
            onClick={() => setPanelOpen((value) => !value)}
          >
            <Icon name="settings" className="size-4" />
          </Button>
        ) : null}

        <Button variant="ghost" size="sm" onClick={() => setShareOpen(true)}>
          <Icon name="link" className="mr-1.5 size-4" />
          {t('share.action')}
        </Button>

        <Button variant="ghost" size="sm" onClick={() => setExportOpen(true)}>
          <Icon name="download" className="mr-1.5 size-4" />
          {t('editor.exportEntry')}
        </Button>

        <Button
          variant={preview ? 'default' : 'outline'}
          size="sm"
          onClick={() => setPreview((value) => !value)}
        >
          <Icon name="eye" className="mr-1.5 size-4" />
          {preview ? t('editor.exitPreview') : t('editor.preview')}
        </Button>
      </header>

      {draft ? (
        <div
          role="status"
          className="flex flex-wrap items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
        >
          <Icon name="clock" className="size-3.5" />
          <span className="flex-1">{t('editor.draft.found', { time: new Date(draft.savedAt).toLocaleString() })}</span>
          <Button size="sm" variant="outline" onClick={restoreDraft}>
            {t('editor.draft.restore')}
          </Button>
          <Button size="sm" variant="ghost" onClick={discardDraft}>
            {t('editor.draft.discard')}
          </Button>
        </div>
      ) : null}

      {/*
        画布容器是键盘焦点的落点：`tabIndex={0}` + 点击即聚焦。
        快捷键只在这个容器有焦点时生效，所以用户在标题输入框里按 Tab
        不会被导图截走。`outline-none` 是因为焦点环画在一个铺满屏幕的
        元素上非常难看——替代的可视反馈是选中节点的描边。
      */}
      <div className="flex min-h-0 flex-1">
        {fonts.ready ? (
          <>
            <div
              ref={canvasRef}
              tabIndex={0}
              onPointerDownCapture={(event) => {
                if (isTextEntryTarget(event.target)) return;
                canvasRef.current?.focus({ preventScroll: true });
              }}
              className="relative min-h-0 flex-1 outline-none"
            >
              <MindMapViewer
                sheet={sheet}
                theme={doc.theme}
                layout={layout}
                plugins={preview ? READ_ONLY_PLUGINS : EDITOR_PLUGINS}
                readOnly={preview}
                viewport={viewport}
                onViewportChange={setViewport}
                selection={selectionSet}
                editingId={preview ? null : editingId}
                ariaLabel={doc.title}
                onSelectionChange={(ids) => store.getState().select(ids)}
                onToggleCollapse={(id) => store.getState().dispatch(toggleCollapseCommand(id))}
                onBeginEdit={(id) => store.getState().setEditing(id)}
                onCancelEdit={() => {
                  store.getState().setEditing(null);
                  canvasRef.current?.focus({ preventScroll: true });
                }}
                onCommitTitle={(id, title, options) => {
                  // 根主题的标题就是导图标题：走 changeTitleCommand 让两个字段一起变，
                  // 否则页头写着「未命名导图」而中心主题写着别的，看起来像保存串了。
                  store
                    .getState()
                    .dispatch(id === sheet.rootTopic.id ? changeTitleCommand(title) : renameTopicCommand(id, title));
                  store.getState().setEditing(null);
                  // 键盘提交后输入框卸载，焦点会掉到 body 上，键盘导航就断了。
                  // 失焦提交（点了别处）不能抢焦点，否则那次点击等于没生效。
                  if (options?.restoreFocus) canvasRef.current?.focus({ preventScroll: true });
                  // 编辑中按 Tab：先落字，再在这个节点下新建子主题并继续编辑。
                  if (options?.addChild) store.getState().dispatch(addChildCommand(id));
                }}
                onMoveTopics={(ids, parentId, index) => {
                  store.getState().dispatch(moveTopicsCommand(ids, parentId, index));
                }}
                onDetachTopics={(ids) => {
                  store.getState().dispatch(detachTopicsCommand(ids));
                }}
              />
            </div>

            {/*
              只读预览不挂面板：验收标准 8 要求页面上不存在可编辑元素，
              面板里全是可编辑控件，留在 DOM 里就算视觉上藏起来也算存在。
            */}
            {!preview && panelOpen ? (
              <CanvasPanel
                tab={panelTab}
                onTab={setPanelTab}
                onClose={() => setPanelOpen(false)}
                label={t('editor.panel.label')}
                tabLabel={(key) => t(key)}
              >
                {panelTab === 'style' && panelStyle ? (
                  <StyleTab
                    targets={panelTargets}
                    style={panelStyle}
                    theme={doc.theme}
                    structure={sheet.structure}
                    onPatch={patchStyle}
                    onStructure={(next) => store.getState().dispatch(changeStructureCommand(next))}
                    onReset={() => store.getState().dispatch(resetStyleCommand(panelTargets))}
                  />
                ) : null}
                {panelTab === 'palette' ? (
                  <PaletteTab theme={doc.theme} onChange={applyTheme} canPersist={enabled} />
                ) : null}
                {panelTab === 'speaker' ? (
                  <div className="flex flex-col gap-1">
                    <span className="text-xs font-semibold text-foreground">
                      {t('editor.panel.speaker.title')}
                    </span>
                    <p className="text-[11px] leading-relaxed text-muted-foreground">
                      {t('editor.panel.speaker.body')}
                    </p>
                  </div>
                ) : null}
              </CanvasPanel>
            ) : null}
          </>
        ) : (
          <EditorSkeleton label={t('editor.loadingFonts')} />
        )}
      </div>

      <footer className="flex items-center justify-between gap-3 border-t border-border/70 px-3 py-1.5 text-xs text-muted-foreground">
        <span>{t('editor.nodeCount', { count: countNodes(doc) })}</span>
        <span>{t('editor.zoomLevel', { percent: Math.round(viewport.zoom * 100) })}</span>
        {enabled ? (
          <SaveIndicator
            save={saveState}
            onRetry={autosave.retry}
            onResolveConflict={() => setConflictOpen(true)}
          />
        ) : (
          <span>{t('editor.save.localOnly')}</span>
        )}
      </footer>

      <ConflictDialog
        open={conflictOpen && autosave.conflict !== null}
        conflict={autosave.conflict}
        localVersion={version}
        busy={autosave.resolving}
        onOverwrite={() => void autosave.overwrite()}
        onReload={() => void autosave.reload()}
        onSaveAsCopy={() => void autosave.saveAsCopy()}
      />

      <LeaveDialog open={autosave.blocked} onStay={autosave.stay} onLeave={autosave.leave} />

      {/*
        分享对话框不按需加载：它只有几个表单控件，比一次动态 import 的
        往返还轻。导出对话框不同，它带着字体分片与栅格化，必须懒加载。
      */}
      <ShareDialog open={shareOpen} mapUid={uid} mapTitle={doc.title} onClose={() => setShareOpen(false)} />

      {exportOpen ? (
        <Suspense fallback={null}>
          <ExportDialog
            open
            document={doc}
            sheetId={sheet.id}
            onClose={() => setExportOpen(false)}
          />
        </Suspense>
      ) : null}
    </div>
  );
}
