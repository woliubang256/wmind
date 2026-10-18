/**
 * 编辑器页面。
 *
 * 文档目前来自内置演示数据（M2.6 换成后端加载）。这一层负责三件事：
 *
 * 1. 持有视口——「缩放到适应」既要知道容器尺寸又要写视口，让查看器自己管
 *    的话工具栏就拿不到写入口；
 * 2. 把 store 与查看器接起来（选中 / 折叠 / 编辑回写）；
 * 3. 把键盘动作接到命令上（见 `useEditorActions`）。
 *
 * 查看器本身不含任何交互：它拿到的是插件列表，只读预览时换一批插件即可。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { countNodes, sheetById } from '@/editor/model/traverse';
import { createEditorStore } from '@/editor/store/editor-store';
import { EditorProvider, useEditor, useEditorStoreApi } from '@/editor/store/use-editor';
import { layoutMindmap } from '@/editor/layout/mindmap';
import { MIN_ZOOM, zoomedViewport } from '@/editor/viewer/plugins/pan-zoom';
import { EDITOR_PLUGINS, READ_ONLY_PLUGINS } from '@/editor/viewer/plugins';
import { MindMapViewer } from '@/editor/viewer/mind-map-viewer';
import type { Viewport } from '@/editor/viewer/viewer-types';
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
import { changeTitleCommand } from '@/editor/commands/document';
import { createDemoDocument, createStressDocument } from './demo-document';

export function EditorPage() {
  const { uid } = useParams();
  // 每张导图一个 store：切路由时重建，避免上一张图的撤销栈泄漏到下一张。
  // `/maps/stress` 是压测入口（验收标准 3），其余 uid 都加载演示文档。
  const store = useMemo(
    () => createEditorStore({ doc: uid === 'stress' ? createStressDocument(2000) : createDemoDocument() }),
    [uid],
  );
  return (
    <EditorProvider store={store}>
      <Workspace />
    </EditorProvider>
  );
}

function Workspace() {
  const { t } = useTranslation();
  const store = useEditorStoreApi();
  const doc = useEditor((state) => state.doc);
  const sheetId = useEditor((state) => state.sheetId);
  const selection = useEditor((state) => state.selection);
  const editingId = useEditor((state) => state.editingId);
  const pastCount = useEditor((state) => state.past.length);
  const futureCount = useEditor((state) => state.future.length);
  const saveStatus = useEditor((state) => state.save.status);

  const [preview, setPreview] = useState(false);
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, zoom: 1 });
  const canvasRef = useRef<HTMLDivElement | null>(null);

  const sheet = useMemo(() => sheetById(doc, sheetId), [doc, sheetId]);
  const layout = useMemo(() => layoutMindmap({ sheet, theme: doc.theme }), [sheet, doc.theme]);
  const selectionSet = useMemo(() => new Set(selection), [selection]);

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
  useEffect(() => {
    const element = canvasRef.current;
    if (!element) return undefined;
    fitRef.current();
    const observer = new ResizeObserver(() => fitRef.current());
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const zoomAtCenter = (factor: number) => {
    const element = canvasRef.current;
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

  /**
   * Ctrl+S。M2.6 接上后端之后这里换成真正的 flush（取消防抖 + 立刻提交）。
   * 现在没有可提交的目标，所以只把状态落成「已保存」——比什么都不做诚实，
   * 也保证键位表是完整的，M2.6 只需替换这一个函数的实现。
   */
  const save = useCallback(() => {
    store.getState().setSave({ status: 'saved', at: Date.now(), error: null });
  }, [store]);

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
  useHotkeys(canvasRef, actions, { enabled: !preview && editingId === null });

  const activeId = selection[0] ?? sheet.rootTopic.id;

  return (
    <div className="flex h-[calc(100svh-9.5rem)] min-h-[420px] flex-col overflow-hidden rounded-2xl border border-border/70 bg-card">
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

        <Button
          variant={preview ? 'default' : 'outline'}
          size="sm"
          onClick={() => setPreview((value) => !value)}
        >
          <Icon name="eye" className="mr-1.5 size-4" />
          {preview ? t('editor.exitPreview') : t('editor.preview')}
        </Button>
      </header>

      {/*
        画布容器是键盘焦点的落点：`tabIndex={0}` + 点击即聚焦。
        快捷键只在这个容器有焦点时生效，所以用户在标题输入框里按 Tab
        不会被导图截走。`outline-none` 是因为焦点环画在一个铺满屏幕的
        元素上非常难看——替代的可视反馈是选中节点的描边。
      */}
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
            store.getState().dispatch(renameTopicCommand(id, title));
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

      <footer className="flex items-center justify-between gap-3 border-t border-border/70 px-3 py-1.5 text-xs text-muted-foreground">
        <span>{t('editor.nodeCount', { count: countNodes(doc) })}</span>
        <span>{t('editor.zoomLevel', { percent: Math.round(viewport.zoom * 100) })}</span>
        <span>{saveStatus === 'dirty' ? t('editor.unsaved') : t('editor.saved')}</span>
      </footer>
    </div>
  );
}
