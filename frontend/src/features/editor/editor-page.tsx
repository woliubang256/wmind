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

import { Suspense, lazy, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { ToolbarButton } from './toolbar-button';
import { InsertMenu } from './insert-menu';
import { InsertDialog } from './insert-dialog';
import { TopicContentPopover } from './topic-content-popover';
import { insertAvailability, type InsertAction } from './insert-actions';
import { updateContentCommand, type ContentPatch } from '@/editor/commands/content';
import { safeTopicHref } from '@/editor/model/topic-content';
import { downloadEmbedded } from './insert-files';
import { Icon } from '@/components/ui/icon';
import { Select } from '@/components/ui/select';
import { collectSummaries, countSheetNodes, findTopic, findTopicInSheet, sheetById } from '@/editor/model/traverse';
import { newSheetId } from '@/editor/model/ids';
import { parseDocument } from '@/editor/model/validate';
import { createEditorStore } from '@/editor/store/editor-store';
import { EditorProvider, useEditor, useEditorStoreApi } from '@/editor/store/use-editor';
import { layoutMindmap } from '@/editor/layout/mindmap';
import { layoutAnnotations, unionRect } from '@/editor/layout/annotations';
import type { LayoutResult } from '@/editor/layout/types';
import { MIN_ZOOM, zoomedViewport } from '@/editor/viewer/plugins/pan-zoom';
import { EDITOR_PLUGINS, READ_ONLY_PLUGINS } from '@/editor/viewer/plugins';
import { MindMapViewer } from '@/editor/viewer/mind-map-viewer';
import { topicElementId } from '@/editor/viewer/a11y-ids';
import type { Viewport } from '@/editor/viewer/viewer-types';
import type { Topic } from '@/editor/model/types';
import type { Style, Theme } from '@/editor/model/types';
import {
  applyThemeCommand,
  changeTopicShapeCommand,
  resetStyleCommand,
  updateStyleCommand,
} from '@/editor/commands/style';
import { CanvasPanel, type PanelTab } from './panel/canvas-panel';
import { StyleTab } from './panel/style-tab';
import { PaletteTab } from './panel/palette-tab';
import { MarkerTab } from './panel/marker-tab';
import { toggleMarkerCommand, clearMarkersCommand } from '@/editor/commands/marker';
import { useHotkeys } from '@/editor/interaction/hotkeys';
import { isTextEntryTarget } from '@/editor/interaction/keymap';
import { useEditorActions } from '@/editor/interaction/use-editor-actions';
import {
  addChildCommand,
  addSiblingCommand,
  detachTopicsCommand,
  moveTopicsCommand,
  removeTopicsCommand,
  renameTopicCommand,
  toggleCollapseCommand,
} from '@/editor/commands/topic';
import { changeStructureCommand, changeTitleCommand } from '@/editor/commands/document';
import {
  addBoundaryCommand,
  addRelationshipCommand,
  addSummaryCommand,
  summaryTarget as getSummaryTarget,
  summaryForRange,
  updateRelationshipStyleCommand,
  updateRelationshipRoutingCommand,
  removeAnnotationCommand,
  renameAnnotationCommand,
  type AnnotationKind,
} from '@/editor/commands/annotation';
import { StructureTab } from './panel/structure-tab';
import {
  addSheetCommand,
  copySheetCommand,
  moveSheetCommand,
  removeSheetCommand,
  renameSheetCommand,
} from '@/editor/commands/sheet';
import { SheetTabs } from './sheet-tabs';
import { CanvasScrollbars } from './canvas-scrollbars';
import { centeredViewport } from './canvas-navigation';
import { downloadBlob } from '@/editor/export/download';
import type { Sheet } from '@/editor/model/types';
import { OutlineView, indentTarget, outdentTarget } from './outline-view';
import { canvasLabel, selectionAnnouncement, type SelectedTopicInfo } from './canvas-a11y';
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
import { SaveTemplateDialog } from '@/features/templates/save-template-dialog';
import { useSiteConfig } from '@/features/site/use-site-config';

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

  const [contentPopover, setContentPopover] = useState<{ topicId: string; sheetId: string; anchor: Element } | null>(null);
  const [preview, setPreview] = useState(false);
  /** 画布 / 大纲两种视图。大纲是同一份文档的另一种投影，切换不丢任何东西。 */
  const [view, setView] = useState<'canvas' | 'outline'>('canvas');
  /** ZEN：只留画布，页头、面板、标签栏、页脚全部收起。 */
  const [zen, setZen] = useState(false);
  const { config } = useSiteConfig();
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, zoom: 1 });
  const [draft, setDraft] = useState<LocalDraft | null>(initialDraft);
  const [conflictOpen, setConflictOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);
  const panelToggleRef = useRef<HTMLButtonElement>(null);
  const togglePanel = () => {
    setPanelOpen((value) => !value);
    requestAnimationFrame(() => panelToggleRef.current?.focus({ preventScroll: true }));
  };
  const [panelTab, setPanelTab] = useState<PanelTab>('style');
  /**
   * 面板里正在编辑的附属结构（概要 / 边界 / 联系）。
   *
   * 不进 store：它不是文档状态，也不该被撤销。放 store 里会让「悬停面板里的
   * 一行」变成一次可能被写进历史的状态变更。
   */
  const [activeAnnotation, setActiveAnnotation] = useState<{ kind: AnnotationKind; id: string } | null>(null);
  useEffect(() => {
    if (selection.length > 0) setActiveAnnotation((current) => current?.kind === 'summary' ? current : null);
  }, [selection]);
  const [insertState, setInsertState] = useState<{ action: InsertAction; ids: string[]; sheetId: string } | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [saveTemplateOpen, setSaveTemplateOpen] = useState(false);
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
  const sheets = doc.sheets;
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

  /*
    画布的读屏描述。

    画布在编辑态是一个 `role="tree"`，但它的内容是 SVG——读屏用户进到画布里
    如果只听到「树」而不知道里面是什么，等于什么也没得到。所以容器的
    `aria-label` 要带上标题与主题数，`aria-describedby` 指向一段只给读屏看的
    键位说明（见下面的 `editor-canvas-hint`）。

    `aria-activedescendant` 是这套做法的关键：焦点落在画布容器上（`<g>` 在
    SVG 里拿不到真正的焦点），活动项靠 id 指过去，方向键一动读屏就念出新节点。
  */
  const nodeCount = useMemo(() => countSheetNodes(sheet), [sheet]);
  const canvasMessage = canvasLabel({ title: doc.title, nodeCount });
  const canvasSummary = t(canvasMessage.key, canvasMessage.params);
  const activeDescendant = selection.length === 1 ? topicElementId(selection[0]!) : undefined;

  /*
    选中变化的播报。首次挂载跳过：一进页面就读「未选中任何主题」纯属噪音，
    读屏用户会以为发生了什么。
  */
  const [announcement, setAnnouncement] = useState('');
  const announcedKey = useRef<string | null>(null);
  useEffect(() => {
    const key = selection.join('\u0000');
    if (announcedKey.current === key) return;
    const isFirstRun = announcedKey.current === null;
    announcedKey.current = key;
    if (isFirstRun) return;

    const infos: SelectedTopicInfo[] = [];
    for (const id of selection) {
      const found = findTopicInSheet(sheet, id);
      if (!found) {
        const summary = collectSummaries(sheet).find((item) => item.id === id);
        if (summary) infos.push({ title: summary.title, level: 1, childCount: 0, collapsed: false });
        continue;
      }
      infos.push({
        title: found.topic.title.trim() || t('editor.a11y.untitled'),
        level: found.depth + 1,
        childCount: found.topic.children.attached.length,
        collapsed: found.topic.collapsed,
      });
    }
    const message = selectionAnnouncement(infos);
    setAnnouncement(t(message.key, message.params));
  }, [selection, sheet, t]);

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
  /*
    面板**显示**用的选区，比动作慢一拍。

    右侧面板是一大棵控件树（样式几十个控件、配色几十个色块），每次选中变化都
    要整棵重渲染。压测实测：面板开着时按一次方向键 25ms（p90 68ms），收起面板
    后回到单帧 16.9ms——也就是说这些时间全花在「把面板重画一遍」上，而用户按
    方向键想看的是画布上的选中框。

    所以把面板的**渲染**降级到低优先级：按键先落地，面板晚一帧跟上，肉眼看不
    出来。注意只降级显示，`panelTargets` 仍然是即时选区——否则「选中 A 后立刻
    点色块」会作用到上一帧的 B 上。
  */
  const deferredSelection = useDeferredValue(selection);
  const panelStyleTargets = useMemo(
    () =>
      (deferredSelection.length > 0 ? deferredSelection : [sheet.rootTopic.id]).filter((id) =>
        layout.styles.has(id),
      ),
    [deferredSelection, sheet.rootTopic.id, layout],
  );
  const panelStyle =
    panelStyleTargets.length > 0 ? (layout.styles.get(panelStyleTargets[0]!) ?? null) : null;

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

  const summaryTarget = useMemo(() => selection.every((id) => findTopicInSheet(sheet, id)) ? getSummaryTarget(sheet, selection) : null, [sheet, selection]);

  const addSummary = useCallback(() => {
    if (summaryTarget === null) return;
    store.getState().dispatch(
      addSummaryCommand({ ...summaryTarget, title: t('editor.annotation.summaryDefault') }),
    );
    const state = store.getState();
    const item = summaryForRange(sheetById(state.doc, state.sheetId), summaryTarget.range);
    if (item) setActiveAnnotation({ kind: 'summary', id: item.id });
    setPanelOpen(true);
    setPanelTab('structure');
    requestAnimationFrame(() => fitRef.current());
  }, [summaryTarget, store, t]);

  const addBoundary = useCallback(() => {
    if (selection.length === 0) return;
    store.getState().dispatch(addBoundaryCommand({ range: selection }));
    setPanelOpen(true);
    setPanelTab('structure');
  }, [selection, store]);

  const addRelationship = useCallback(() => {
    if (selection.length !== 2) return;
    store.getState().dispatch(
      addRelationshipCommand({ fromId: selection[0] ?? '', toId: selection[1] ?? '' }),
    );
    const state = store.getState();
    const item = sheetById(state.doc, state.sheetId).relationships.at(-1);
    if (item) { state.select([]); setActiveAnnotation({ kind: 'relationship', id: item.id }); }
    setPanelOpen(true);
    setPanelTab('structure');
  }, [selection, store]);

  const contentBounds = useMemo(() => {
    const annotations = layoutAnnotations(sheet, layout, sheet.themeOverride ?? doc.theme);
    return unionRect([layout.bounds, ...(annotations.bounds ? [annotations.bounds] : [])], 16)!;
  }, [sheet, layout, doc.theme]);

  const fit = useCallback(() => {
    const element = canvasRef.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const raw = Math.min(rect.width / contentBounds.width, rect.height / contentBounds.height) * 0.94;
    const zoom = Math.max(MIN_ZOOM, Math.min(1.2, raw));
    setViewport({
      zoom,
      x: (rect.width - contentBounds.width * zoom) / 2 - contentBounds.x * zoom,
      y: (rect.height - contentBounds.height * zoom) / 2 - contentBounds.y * zoom,
    });
  }, [contentBounds]);

  // 只在挂载与容器尺寸变化时重新适配。用 ref 拿最新的 fit，避免把 fit 放进
  // 依赖数组——否则每敲一个字都会重新适配一次，用户手动缩放的位置会被抢走。
  const fitRef = useRef(fit);
  fitRef.current = fit;
  // 依赖 fonts.ready：骨架屏期间 canvasRef 还是 null，只在挂载时跑一次的话，
  // 字体就绪、画布真正挂上之后就没人观察容器尺寸了。
  // 依赖 view：切到大纲再切回来，画布是**重新挂载**的，ref 换了新元素，
  // 不重跑这里就既不会适配视野也没有 ResizeObserver。
  useEffect(() => {
    const element = canvasRef.current;
    if (!element) return undefined;
    fitRef.current();
    const observer = new ResizeObserver(() => fitRef.current());
    observer.observe(element);
    return () => observer.disconnect();
  }, [fonts.ready, view]);

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

  /**
   * 切换画布后重新适配视野。
   *
   * 每张画布的包围盒差别可以很大（一张三个节点、一张三百个），沿用上一张的
   * 视口会让新画布要么小得看不清、要么整棵树都在屏幕外。这里与「换结构」
   * 同一套逻辑，只是触发源换成 `sheetId`。
   */
  const fittedSheet = useRef(sheetId);
  useEffect(() => {
    if (fittedSheet.current === sheetId) return;
    fittedSheet.current = sheetId;
    setActiveAnnotation(null);
    fitRef.current();
  }, [sheetId]);

  const zoomAtCenter = (factor: number) => {
    const element = canvasRef.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    setViewport((prev) => zoomedViewport(prev, factor, { x: rect.width / 2, y: rect.height / 2 }));
  };

  /** 快捷比例与 Ctrl+0 共用画布中心锚点，不改变文档或撤销历史。 */
  const setZoom = useCallback((zoom: number) => {
    const element = canvasRef.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    setViewport((prev) =>
      zoomedViewport(prev, zoom / prev.zoom, { x: rect.width / 2, y: rect.height / 2 }),
    );
  }, []);
  const resetZoom = useCallback(() => setZoom(1), [setZoom]);
  const centerTopic = () => {
    const element = canvasRef.current;
    const root = layout.boxes.get(sheet.rootTopic.id);
    if (!element || !root) return;
    const rect = element.getBoundingClientRect();
    setViewport((prev) => centeredViewport(prev, root, rect));
  };

  /** Ctrl+S：跳过防抖，立刻落盘。 */
  const save = useCallback(() => {
    void autosave.flush();
  }, [autosave]);

  const deleteSelection = useCallback(() => {
    const state = store.getState();
    if (state.selection.length) {
      state.dispatch(removeTopicsCommand(state.selection));
      setActiveAnnotation(null);
    } else if (activeAnnotation && activeAnnotation.kind !== 'summary') {
      state.dispatch(removeAnnotationCommand(activeAnnotation.kind, activeAnnotation.id));
      setActiveAnnotation(null);
    }
  }, [activeAnnotation, store]);

  const actions = useEditorActions({
    layout,
    sheet,
    onFit: fit,
    onResetZoom: resetZoom,
    onSave: save,
    onDeleteSelection: deleteSelection,
    onClearSelection: () => setActiveAnnotation(null),
  });

  /**
   * 多画布：新增、改名、删除、排序、切换。
   *
   * 全部走命令（切换除外，它是视图状态），所以每一步都能撤销。新增之后要
   * 立刻切过去——建了一张画布却停在旧画布上，用户会以为没建成功。
   */
  const addSheet = useCallback(() => {
    const id = newSheetId();
    const state = store.getState();
    const active = sheetById(state.doc, state.sheetId);
    state.dispatch(
      addSheetCommand({
        id,
        title: t('editor.sheets.defaultTitle', { index: state.doc.sheets.length + 1 }),
        // 沿用当前画布的结构：「再加一张同样的图」是最常见的意图。
        structure: active.structure,
      }),
    );
    store.getState().setSheet(id);
  }, [store, t]);

  const [sheetClipboard, setSheetClipboard] = useState<Sheet | null>(null);
  const copySheet = (id: string) => {
    const source = store.getState().doc.sheets.find((item) => item.id === id);
    if (source) setSheetClipboard(structuredClone(source));
  };
  const pasteSheet = (afterId: string, source = sheetClipboard) => {
    if (!source) return;
    const id = newSheetId();
    store.getState().dispatch(copySheetCommand(source, id, t('editor.sheets.copyTitle', { title: source.title }), afterId));
    store.getState().setSheet(id);
  };
  const saveSheetAs = (id: string) => {
    const current = store.getState().doc;
    const source = current.sheets.find((item) => item.id === id);
    if (!source) return;
    const document = { ...current, title: source.title, sheets: [source] };
    const filename = source.title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_') || 'canvas';
    downloadBlob(new Blob([JSON.stringify(document, null, 2)], { type: 'application/json' }), `${filename}.wmind`);
  };

  const renameSheet = useCallback(
    (id: string, title: string) => {
      store.getState().dispatch(renameSheetCommand(id, title));
    },
    [store],
  );

  const deleteSheet = useCallback(
    (id: string) => {
      const before = store.getState();
      const index = before.doc.sheets.findIndex((item) => item.id === id);
      before.dispatch(removeSheetCommand(id));

      // 删的是当前画布时得挑一张接上：优先右边的（原来的下一张），
      // 没有就左边。不切的话 `sheetById` 会静默回落到第一张，而 store 里的
      // `sheetId` 还指着一张已经不存在的画布。
      if (before.sheetId !== id) return;
      const remaining = store.getState().doc.sheets;
      const next = remaining[Math.min(Math.max(index, 0), remaining.length - 1)];
      if (next) store.getState().setSheet(next.id);
    },
    [store],
  );

  const moveSheet = useCallback(
    (id: string, toIndex: number) => {
      store.getState().dispatch(moveSheetCommand(id, toIndex));
    },
    [store],
  );

  /**
   * 改节点文字。画布与大纲共用一份，两处口径必须一致——否则同一个节点
   * 从画布改和从大纲改，一个会顺带改导图名、另一个不会。
   *
   * 只有**第一张**画布的中心主题等于导图标题。第二张之后的中心主题只是
   * 那张画布的内容，改它不该把整份导图改名——否则用户在画布 2 上给中心
   * 主题起个名字，列表页里的导图名也跟着变了。
   */
  const commitTitle = useCallback(
    (id: string, title: string) => {
      const state = store.getState();
      const current = sheetById(state.doc, state.sheetId);
      const isCoverTopic = id === current.rootTopic.id && current.id === state.doc.sheets[0]?.id;
      state.dispatch(collectSummaries(current).some((item) => item.id === id) ? renameAnnotationCommand('summary', id, title) : isCoverTopic ? changeTitleCommand(title) : renameTopicCommand(id, title));
    },
    [store],
  );

  const indentTopic = useCallback(
    (id: string) => {
      const target = indentTarget(sheet, id);
      if (!target) return;
      store.getState().dispatch(moveTopicsCommand([id], target.parentId, target.index));
    },
    [sheet, store],
  );

  const outdentTopic = useCallback(
    (id: string) => {
      const target = outdentTarget(sheet, id);
      if (!target) return;
      store.getState().dispatch(moveTopicsCommand([id], target.parentId, target.index));
    },
    [sheet, store],
  );

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
  useHotkeys(rootRef, actions, { enabled: !preview && editingId === null && insertState === null });

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
    // 大纲视图没有画布可聚焦；从大纲切回画布时再抢一次焦点（依赖里有 view）。
    if (view !== 'canvas') return;
    canvasRef.current?.focus({ preventScroll: true });
  }, [preview, fonts.ready, view]);

  /**
   * ZEN 的进出。
   *
   * Esc 监听挂在 `window` 上而不是编辑器根节点：进 ZEN 会把页头连同「进入
   * ZEN」按钮一起卸掉，而它正是当时的焦点所在——元素一消失，焦点落到
   * body，挂在根节点上的键盘监听就再也收不到事件，用户会被关在全屏里。
   * 出来时把焦点交给画布，键盘操作不至于断在原地。
   */
  useEffect(() => {
    if (!zen) return undefined;
    canvasRef.current?.focus({ preventScroll: true });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setZen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [zen]);

  const selectedTopics = selection.flatMap((id) => { const found = findTopicInSheet(sheet, id); return found ? [found.topic] : []; });
  const activeId = selection[0] ?? sheet.rootTopic.id;
  const closeContentPopover = useCallback((restoreFocus = true) => {
    if (restoreFocus && contentPopover?.anchor.isConnected) { const anchor = contentPopover.anchor as SVGElement; requestAnimationFrame(() => anchor.focus?.({ preventScroll: true })); }
    setContentPopover(null);
  }, [contentPopover]);
  useEffect(() => { setContentPopover(null); }, [sheetId, view, preview, viewport.x, viewport.y, viewport.zoom]);
  const popoverTopic = contentPopover?.sheetId === sheet.id ? findTopicInSheet(sheet, contentPopover.topicId)?.topic : undefined;
  const openInsert = (action: InsertAction, ids = selection) => {
    const current = store.getState(); const currentSheet = sheetById(current.doc, current.sheetId);
    const count = ids.filter((id) => findTopicInSheet(currentSheet, id)).length;
    if (insertAvailability(action, count, ids.length)) return;
    setContentPopover(null);
    current.setEditing(null);
    setInsertState({ action, ids: [...ids], sheetId: currentSheet.id });
  };
  const saveInsert = (patch: ContentPatch) => {
    const current = store.getState();
    if (!insertState || current.sheetId !== insertState.sheetId) throw new Error('sheet-changed');
    current.dispatch(updateContentCommand(insertState.ids, patch));
    setInsertState(null);
    requestAnimationFrame(() => { canvasRef.current?.focus({ preventScroll: true }); fitRef.current(); });
  };
  const openTopicLink = (topic: Topic) => {
    setContentPopover(null);
    if (topic.content?.localLink) downloadEmbedded(topic.content.localLink);
    else if (topic.href.startsWith('xmind:#')) {
      const found = findTopic(doc, topic.href.slice(7));
      if (found) { store.getState().setSheet(found.sheet.id); store.getState().select([found.topic.id]); requestAnimationFrame(() => fitRef.current()); }
    } else if (safeTopicHref(topic.href)) window.open(topic.href, '_blank', 'noopener,noreferrer');
  };
  const contentClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const target = (event.target as Element).closest('[data-topic-content-kind]');
    const topicId = target?.closest('[data-topic-id]')?.getAttribute('data-topic-id');
    if (!target || !topicId) return;
    const topic = findTopicInSheet(sheet, topicId)?.topic; if (!topic) return;
    event.preventDefault(); event.stopPropagation();
    const kind = target.getAttribute('data-topic-content-kind');
    if (kind === 'note' || kind === 'link' || kind === 'more') {
      setContentPopover((current) => current?.topicId === topicId ? null : { topicId, sheetId: sheet.id, anchor: target });
    } else if (kind === 'attachment') {
      const file = topic.content?.attachments?.find((item) => item.id === target.getAttribute('data-content-id'));
      if (file) downloadEmbedded(file);
    } else if (!preview) {
      if (kind === 'todo') store.getState().dispatch(updateContentCommand([topicId], { content: { todo: !topic.content?.todo } }));
      else if (kind) openInsert(kind as InsertAction, [topicId]);
    }
  };
  const contentKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!['Enter', ' '].includes(event.key) || event.nativeEvent.isComposing) return;
    const target = (event.target as Element).closest<SVGElement>('[data-topic-content-kind]');
    if (!target) return;
    event.preventDefault(); event.stopPropagation(); target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  };


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
      // ZEN 用 CSS 撑满视口而不是另挂一棵子树：画布一旦卸载再挂回来，
      // ResizeObserver、字体测量缓存、焦点全都要重来一遍，切进切出会闪。
      className={[
        'relative flex flex-col overflow-hidden bg-card',
        zen
          ? 'fixed inset-0 z-50 h-svh min-h-0'
          // 顶栏是 3.5rem（h-14），内容区不再套内边距：编辑器要吃掉整块屏幕，
          // 圆角与边框留给面板内部的小卡片。
          : 'h-[calc(100svh-3.5rem)] min-h-[420px]',
      ].join(' ')}
    >
      {zen ? null : (
      <header className="flex flex-wrap items-center gap-2 border-b border-border/70 px-3 py-2">
        <Link
          to="/"
          aria-label={t('editor.back')}
          title={t('editor.back')}
          className="inline-flex size-10 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          <Icon name="chevron-left" className="size-4" />
        </Link>

        <input
          value={doc.title}
          aria-label={t('editor.titlePlaceholder')}
          onChange={(event) => store.getState().dispatch(changeTitleCommand(event.target.value))}
          className="min-w-32 basis-40 flex-1 rounded-md bg-transparent px-2 py-1 text-sm font-semibold outline-none hover:bg-muted focus:bg-muted"
        />

        {preview ? (
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
            {t('editor.readOnly')}
          </span>
        ) : null}

        <div data-editor-toolbar className="flex min-w-0 max-w-full basis-full flex-wrap items-center gap-x-2 gap-y-1 xl:basis-auto">
          <div role="group" aria-label={t('editor.toolbar.edit')} className="flex min-w-0 max-w-full flex-wrap items-center gap-0.5">
            <div className="flex items-center gap-0.5">
              <ToolbarButton
                variant="ghost"
                size="icon"
                aria-label={t('editor.undo')} shortcut="⌘ / Ctrl + Z" disabledReason={t('editor.hint.noUndo')}
                disabled={pastCount === 0}
                onClick={() => store.getState().undo()}
              >
                <Icon name="undo" className="size-4" />
              </ToolbarButton>
              <ToolbarButton
                variant="ghost"
                size="icon"
                aria-label={t('editor.redo')} shortcut="⌘ / Ctrl + Shift + Z" disabledReason={t('editor.hint.noRedo')}
                disabled={futureCount === 0}
                onClick={() => store.getState().redo()}
              >
                <Icon name="redo" className="size-4" />
              </ToolbarButton>
            </div>

            {!preview ? (
              <div className="flex items-center gap-0.5">
                <ToolbarButton variant="ghost" size="icon" aria-label={t('editor.addSibling')} shortcut="Enter"
                  hint={t('editor.addSibling')} disabled={selection.length !== 1 || selectedTopics.length !== 1 || activeId === sheet.rootTopic.id}
                  disabledReason={activeId === sheet.rootTopic.id && selection.length === 1 ? t('editor.hint.rootSibling') : t('editor.hint.oneTopic')}
                  onClick={() => store.getState().dispatch(addSiblingCommand(activeId))}><Icon name="waypoints" className="size-4" /></ToolbarButton>
                <ToolbarButton variant="ghost" size="icon" aria-label={t('editor.addChild')} shortcut="Tab"
                  hint={t('editor.addChild')} disabled={selection.length !== 1 || selectedTopics.length !== 1} disabledReason={t('editor.hint.oneTopic')}
                  onClick={() => store.getState().dispatch(addChildCommand(activeId))}><Icon name="topic-child" className="size-4" /></ToolbarButton>
                <InsertMenu topics={selectedTopics.length} selection={selection.length} onInsert={openInsert} />
                <ToolbarButton
                  variant="ghost"
                  size="icon"
                  aria-label={t('editor.delete')} shortcut="Delete" hint={t('editor.hint.delete')} disabledReason={t('editor.emptySelection')}
                  disabled={selection.length === 0 && activeAnnotation === null}
                  onClick={deleteSelection}
                >
                  <Icon name="trash" className="size-4" />
                </ToolbarButton>
                <ToolbarButton
                  variant="ghost"
                  size="icon"
                  aria-label={t('editor.collapse')} shortcut="⌘ / Ctrl + ." hint={t('editor.hint.collapse')} disabledReason={t('editor.hint.oneTopic')}
                  disabled={selection.length !== 1}
                  onClick={() => store.getState().dispatch(toggleCollapseCommand(selection[0] ?? ''))}
                >
                  <Icon name="chevron-right" className="size-4" />
                </ToolbarButton>
              </div>
            ) : null}

            {!preview ? (
              <div className="flex items-center gap-0.5">
                <ToolbarButton
                  variant="ghost"
                  size="icon"
                  aria-label={t('editor.annotation.summary')}
                  hint={t('editor.hint.summary')} disabledReason={t('editor.hint.summarySelection')}
                  disabled={summaryTarget === null}
                  onClick={addSummary}
                >
                  <Icon name="summary" className="size-4" />
                </ToolbarButton>
                <ToolbarButton
                  variant="ghost"
                  size="icon"
                  aria-label={t('editor.annotation.boundary')}
                  hint={t('editor.hint.boundary')} disabledReason={t('editor.hint.boundarySelection')}
                  disabled={selection.length === 0 || selection.some((id) => !layout.boxes.has(id))}
                  onClick={addBoundary}
                >
                  <Icon name="boundary" className="size-4" />
                </ToolbarButton>
                <ToolbarButton
                  variant="ghost"
                  size="icon"
                  aria-label={t('editor.annotation.relationship')}
                  hint={t('editor.hint.relationship')} disabledReason={t('editor.hint.relationshipSelection')}
                  disabled={selection.length !== 2}
                  onClick={addRelationship}
                >
                  <Icon name="relationship" className="size-4" />
                </ToolbarButton>
              </div>
            ) : null}

            {!preview ? <ToolbarButton variant="ghost" size="icon" aria-label={t('editor.marker.title')}
              hint={t('editor.marker.hint')} aria-pressed={panelOpen && panelTab === 'markers'}
              onClick={() => { setPanelTab('markers'); setPanelOpen(true); }}>
              <Icon name="flag" className="size-4" />
            </ToolbarButton> : null}
          </div>

          <div role="group" aria-label={t('editor.toolbar.view')} className="flex min-w-0 max-w-full flex-wrap items-center gap-0.5 border-l border-border/80 pl-2">
            <div className="flex items-center gap-0.5">
              <ToolbarButton variant="ghost" size="icon" aria-label={t('editor.zoomOut')} onClick={() => zoomAtCenter(1 / 1.2)}>
                <Icon name="zoom-out" className="size-4" />
              </ToolbarButton>
              <ToolbarButton variant="ghost" size="icon" aria-label={t('editor.zoomIn')} onClick={() => zoomAtCenter(1.2)}>
                <Icon name="zoom-in" className="size-4" />
              </ToolbarButton>
              <ToolbarButton variant="ghost" size="icon" aria-label={t('editor.fit')} shortcut="⌘ / Ctrl + 1" onClick={fit}>
                <Icon name="maximize" className="size-4" />
              </ToolbarButton>
            </div>

            {/*
              视图切换（画布 / 大纲）与 ZEN。三个都是「看同一份文档的不同方式」，
              因此统一放在界面分组，且都只在编辑态出现。
            */}
            {!preview ? (
              <>
                <ToolbarButton
                  variant={view === 'outline' ? 'secondary' : 'ghost'}
                  size="icon"
                  aria-label={t('editor.outline.toggle')}
                  aria-pressed={view === 'outline'}
                  onClick={() => setView((value) => (value === 'outline' ? 'canvas' : 'outline'))}
                >
                  <Icon name="list" className="size-4" />
                </ToolbarButton>
                {view === 'canvas' ? (
                  <ToolbarButton
                    variant="ghost"
                    size="icon"
                    aria-label={t('editor.zen.enter')}
                    onClick={() => setZen(true)}
                  >
                    <Icon name="maximize" className="size-4" />
                  </ToolbarButton>
                ) : null}
              </>
            ) : null}

            <ToolbarButton
              aria-label={preview ? t('editor.exitPreview') : t('editor.preview')}
              aria-pressed={preview}
              variant={preview ? 'default' : 'outline'}
              size="icon"
              onClick={() => setPreview((value) => !value)}
            >
              <Icon name="eye" className="size-4" />
            </ToolbarButton>
          </div>

          {(!preview && config.userTemplateEnabled) || config.shareEnabled || config.exportEnabled ? (
            <div role="group" aria-label={t('editor.toolbar.actions')} className="flex min-w-0 max-w-full flex-wrap items-center gap-0.5 border-l border-border/80 pl-2">
              {/*
                「另存为模板」只在允许用户模板时出现。它是把当前导图复制一份存起来，
                属于写操作；站点关掉用户模板后还留一个必然 403 的按钮没有意义。
              */}
              {!preview && config.userTemplateEnabled ? (
                <ToolbarButton variant="ghost" size="icon" aria-label={t('templates.saveAs')} onClick={() => setSaveTemplateOpen(true)}>
                  <Icon name="save" className="size-4" />
                </ToolbarButton>
              ) : null}

              {/*
                分享与导出都跟着站点开关走。两个都是「点了必然失败」的按钮：
                站点关掉分享后 `POST /shares` 回 403 `SHARE_DISABLED`，而导出虽然
                全在浏览器里做、服务端拦不住，但把一个管理员明确关掉的能力继续摆在
                工具栏上，等于让设置项看起来没生效。
              */}
              {config.shareEnabled ? (
                <ToolbarButton aria-label={t('share.action')} variant="ghost" size="icon" onClick={() => setShareOpen(true)}>
                  <Icon name="link" className="size-4" />
                </ToolbarButton>
              ) : null}

              {config.exportEnabled ? (
                <ToolbarButton aria-label={t('editor.exportEntry')} variant="ghost" size="icon" onClick={() => setExportOpen(true)}>
                  <Icon name="download" className="size-4" />
                </ToolbarButton>
              ) : null}
            </div>
          ) : null}
        </div>
      </header>
      )}

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
        不会被导图截走。

        焦点环只在**键盘**聚焦时出现（`focus-visible`）。鼠标点一下画布也会
        让它聚焦，若用 `focus:` 就会在每次点击后闪一圈框；而纯 `outline-none`
        又会让键盘用户完全看不出焦点在哪——导图里没有原生控件，没有焦点环
        就等于没有位置感。
      */}
      <p id="editor-canvas-hint" className="sr-only">
        {t('editor.a11y.canvasHint')}
      </p>
      <div className="relative flex min-h-0 flex-1">
        {view === 'outline' && !preview ? (
          <OutlineView
            doc={doc}
            sheet={sheet}
            selection={selection}
            onSelect={(ids) => store.getState().select(ids)}
            onCommitTitle={commitTitle}
            onAddChild={(id) => store.getState().dispatch(addChildCommand(id))}
            onDelete={(ids) => store.getState().dispatch(removeTopicsCommand(ids))}
            onToggleCollapse={(id) => store.getState().dispatch(toggleCollapseCommand(id))}
            onIndent={indentTopic}
            onOutdent={outdentTopic}
          />
        ) : fonts.ready ? (
          <>
            <div
              ref={canvasRef}
              /* 预览态没有快捷键可用，把整个画布移出 Tab 序列：一个没有角色、
                 没有名字的可聚焦元素只会让键盘用户多按一次 Tab。 */
              tabIndex={preview ? -1 : 0}
              /*
                只读预览里不声明树：那时整张图是一个 `img`（见 MindMapViewer），
                外面再套一层空的 `role="tree"` 会让读屏报出一棵没有子项的树。
                键位说明同理——预览态没有任何快捷键可用。
              */
              role={preview ? undefined : 'tree'}
              aria-label={preview ? undefined : canvasSummary}
              aria-multiselectable={preview ? undefined : true}
              aria-activedescendant={preview ? undefined : activeDescendant}
              aria-describedby={preview ? undefined : 'editor-canvas-hint'}
              onPointerDownCapture={(event) => {
                if (isTextEntryTarget(event.target)) return;
                canvasRef.current?.focus({ preventScroll: true });
              }}
              className="relative min-h-0 flex-1 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40"
            >
              <div id="editor-canvas-surface" className="h-full w-full" onClickCapture={contentClick} onKeyDownCapture={contentKeyDown}>
              <MindMapViewer
                sheet={sheet}
                theme={doc.theme}
                layout={layout}
                plugins={preview ? READ_ONLY_PLUGINS : EDITOR_PLUGINS}
                readOnly={preview}
                contentInteractive
                viewport={viewport}
                onViewportChange={setViewport}
                selection={selectionSet}
                editingId={preview ? null : editingId}
                selectedAnnotationId={preview ? null : activeAnnotation?.id ?? null}
                ariaLabel={doc.title}
                onSelectionChange={(ids) => { store.getState().select(ids);
                  const summary = ids.length === 1 && collectSummaries(sheet).find((item) => item.id === ids[0]);
                  setActiveAnnotation(summary ? { kind: 'summary', id: summary.id } : null);
                }}
                onSelectBoundary={(id) => {
                  store.getState().select([]);
                  store.getState().setEditing(null);
                  setActiveAnnotation({ kind: 'boundary', id });
                  setPanelOpen(true); setPanelTab('structure');
                }}
                onSelectRelationship={(id) => {
                  store.getState().select([]);
                  store.getState().setEditing(null);
                  setActiveAnnotation({ kind: 'relationship', id });
                  setPanelOpen(true);
                  setPanelTab('structure');
                }}
                onCommitRelationshipRouting={(id, routing, curve) => store.getState().dispatch(updateRelationshipRoutingCommand(id, routing, curve))}
                onCommitRelationshipTitle={(id, title, restoreFocus) => {
                  if (title !== null) store.getState().dispatch(renameAnnotationCommand('relationship', id, title));
                  if (restoreFocus) canvasRef.current?.focus({ preventScroll: true });
                }}
                onToggleCollapse={(id) => store.getState().dispatch(toggleCollapseCommand(id))}
                onBeginEdit={(id) => store.getState().setEditing(id)}
                onCancelEdit={() => {
                  store.getState().setEditing(null);
                  canvasRef.current?.focus({ preventScroll: true });
                }}
                onCommitTitle={(id, title, options) => {
                  commitTitle(id, title);
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
              <CanvasScrollbars canvasRef={canvasRef} bounds={contentBounds} viewport={viewport} onChange={setViewport} />
            </div>

            {/*
              只读预览不挂面板：验收标准 8 要求页面上不存在可编辑元素，
              面板里全是可编辑控件，留在 DOM 里就算视觉上藏起来也算存在。
            */}
            {!preview && panelOpen && !zen ? (
              <CanvasPanel
                tab={panelTab}
                onTab={setPanelTab}
                onClose={togglePanel}
                toggleRef={panelToggleRef}
                label={t('editor.panel.label')}
                tabLabel={(key) => t(key)}
              >
                {panelTab === 'style' && panelStyle ? (
                  <StyleTab
                    targets={panelTargets}
                    style={panelStyle}
                    theme={doc.theme}
                    structure={sheet.structure}
                    shape={sheet.topicShape}
                    onShape={(shape) => store.getState().dispatch(changeTopicShapeCommand(shape))}
                    onPatch={patchStyle}
                    onStructure={(next) => store.getState().dispatch(changeStructureCommand(next))}
                    onReset={() => store.getState().dispatch(resetStyleCommand(panelTargets))}
                  />
                ) : null}
                {panelTab === 'markers' ? (
                  <MarkerTab topics={selection.flatMap((id) => { const found = findTopicInSheet(sheet, id); return found ? [found.topic] : []; })}
                    onToggle={(markerId) => store.getState().dispatch(toggleMarkerCommand(selection, markerId))}
                    onClear={() => store.getState().dispatch(clearMarkersCommand(selection))} />
                ) : null}
                {panelTab === 'palette' ? (
                  <PaletteTab theme={doc.theme} onChange={applyTheme} canPersist={enabled} />
                ) : null}
                {panelTab === 'structure' ? (
                  <StructureTab
                    sheet={sheet}
                    theme={sheet.themeOverride ?? doc.theme}
                    selection={selection}
                    activeId={activeAnnotation?.id ?? null}
                    onActivate={(kind, id) => {
                      if (id !== null) store.getState().select(kind === 'summary' ? [id] : []);
                      setActiveAnnotation(id === null ? null : { kind, id });
                    }}
                    onAddSummary={addSummary}
                    onAddBoundary={addBoundary}
                    onAddRelationship={addRelationship}
                    onResetRelationshipRouting={(id) => store.getState().dispatch(updateRelationshipRoutingCommand(id, null))}
                  onPatchRelationship={(id, patch) => store.getState().dispatch(updateRelationshipStyleCommand(id, patch))}
                    onRename={(kind, id, title) =>
                      store.getState().dispatch(renameAnnotationCommand(kind, id, title))
                    }
                    onRemove={(kind, id) => {
                      store.getState().dispatch(removeAnnotationCommand(kind, id));
                      setActiveAnnotation(null);
                    }}
                  />
                ) : null}
              </CanvasPanel>
            ) : null}
            {!preview && !panelOpen && !zen ? (
              <ToolbarButton ref={panelToggleRef} variant="ghost" size="icon"
                aria-label={t('editor.panel.show')} aria-expanded={false} aria-controls="editor-canvas-panel"
                onClick={togglePanel}
                className="absolute right-1.5 top-1 z-20 size-7 rounded-full border border-border bg-card shadow-sm">
                <Icon name="panel-right-open" className="size-4" />
              </ToolbarButton>
            ) : null}
          </>
        ) : (
          <EditorSkeleton label={t('editor.loadingFonts')} />
        )}
      </div>

      {/*
        画布标签栏：只在编辑态出现。只读预览是「导出会长什么样」的预览，
        多一个切画布的入口会让它看起来像可编辑的。ZEN 里也收起——「全屏
        编辑」的全部意思就是除了画布什么都不剩。
      */}
      {zen ? null : (
      <footer className="flex min-w-0 items-center gap-3 border-t border-border/70 bg-muted/30 px-2 py-1 text-xs text-muted-foreground">
      {!preview ? (
        <SheetTabs
          sheets={sheets}
          activeId={sheet.id}
          onSwitch={(id) => store.getState().setSheet(id)}
          onAdd={addSheet}
          onRename={renameSheet}
          onDelete={deleteSheet}
          onMove={moveSheet}
          canPaste={sheetClipboard !== null}
          onCopy={copySheet}
          onPaste={pasteSheet}
          onDuplicate={(id) => pasteSheet(id, store.getState().doc.sheets.find((item) => item.id === id))}
          onSaveAs={saveSheetAs}
        />
      ) : null}

        <div className="ml-auto flex shrink-0 items-center gap-3 whitespace-nowrap">
        <span>{t('editor.nodeCount', { count: nodeCount })}</span>
        <Select
          aria-label={t('editor.zoomPresets')}
          size="sm"
          menuMinWidth={112}
          value={Number((viewport.zoom * 100).toFixed(6))}
          options={[50, 75, 100, 125, 150, 200].map((percent) => ({ value: percent, label: `${percent}%` }))}
          disabled={view !== 'canvas' || !fonts.ready}
          onChange={(percent) => setZoom(percent / 100)}
          renderTrigger={(props) => (
            <button {...props} title={t('editor.zoomPresets')}
              className="-my-0.5 inline-flex items-center gap-1 rounded px-1 py-0.5 text-xs outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60">
              <span>{t('editor.zoomLevel', { percent: Math.round(viewport.zoom * 100) })}</span>
              <Icon name="chevron-down" className="size-3 rotate-180" />
            </button>
          )}
        />
        <Button variant="ghost" size="icon" className="size-7" title={t('editor.centerTopic')} aria-label={t('editor.centerTopic')}
          disabled={view !== 'canvas' || !fonts.ready} onClick={centerTopic}>
          <Icon name="locate" className="size-3.5" />
        </Button>
        {enabled ? (
          <SaveIndicator
            save={saveState}
            onRetry={autosave.retry}
            onResolveConflict={() => setConflictOpen(true)}
          />
        ) : (
          <span>{t('editor.save.localOnly')}</span>
        )}
        </div>
      </footer>
      )}

      {/*
        ZEN 里唯一留下的界面元素：退出按钮。没有它，用户只能靠 Esc 或刷新
        页面出来——而「只能靠 Esc」这件事没有任何提示。
      */}
      {zen ? (
        <Button
          variant="outline"
          size="sm"
          aria-label={t('editor.zen.exit')}
          onClick={() => setZen(false)}
          className="absolute right-3 top-3 shadow-sm"
        >
          <Icon name="minimize" className="mr-1.5 size-4" />
          {t('editor.zen.exit')}
        </Button>
      ) : null}

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
      <SaveTemplateDialog
        open={saveTemplateOpen}
        mapUid={uid}
        defaultName={doc.title}
        onClose={() => setSaveTemplateOpen(false)}
      />

      {contentPopover && popoverTopic ? <TopicContentPopover key={`${contentPopover.sheetId}:${contentPopover.topicId}`} topic={popoverTopic}
        anchor={contentPopover.anchor} readOnly={preview} onClose={closeContentPopover}
        linkTitle={popoverTopic.content?.localLink?.name ?? (popoverTopic.href.startsWith('xmind:#') ? findTopic(doc, popoverTopic.href.slice(7))?.topic.title ?? '…' : popoverTopic.href)}
        onEdit={(action) => openInsert(action, [popoverTopic.id])} onOpenLink={() => openTopicLink(popoverTopic)} /> : null}
      {insertState && insertState.sheetId === sheet.id && insertState.ids.every((id) => findTopicInSheet(sheet, id)) ? <InsertDialog
        key={`${insertState.sheetId}:${insertState.action}:${insertState.ids.join(',')}`} action={insertState.action}
        topics={insertState.ids.map((id) => findTopicInSheet(sheet, id)!.topic)} doc={doc} onSave={saveInsert}
        onClose={() => { setInsertState(null); canvasRef.current?.focus({ preventScroll: true }); }} /> : null}
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

      {/*
        选中播报的落点。

        为什么不把播报直接写进画布的 `aria-label`：`aria-label` 变化不会主动
        触发读屏发声，只有**焦点变化**才会。而方向键导航时焦点一直留在画布
        容器上，所以必须靠一个 `aria-live` 区域把「现在选中了谁」推出去。

        `polite` 而不是 `assertive`：用户连按三下方向键时，assertive 会把每一句
        都插进来互相打断，polite 只念最后一句——这恰好是想要的行为。
      */}
      <div aria-live="polite" role="status" data-canvas-announcer className="sr-only">
        {announcement}
      </div>
    </div>
  );
}
