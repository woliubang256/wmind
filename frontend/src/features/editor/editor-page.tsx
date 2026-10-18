/**
 * 编辑器页面。
 *
 * M2.3 阶段只做「渲染 + 只读查看器」的可见化：文档来自内置演示数据
 * （M2.6 换成后端加载），工具栏提供撤销 / 重做 / 缩放 / 折叠 / 只读预览，
 * 用来验证渲染层与插件抽象。键盘与拖拽在 M2.4 / M2.5 补。
 *
 * 视口由页面持有（受控），因为「缩放到适应」既要知道容器尺寸又要写视口——
 * 让查看器自己管会让工具栏拿不到写入口。
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
import {
  addChildCommand,
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

      <div ref={canvasRef} className="relative min-h-0 flex-1">
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
          onCancelEdit={() => store.getState().setEditing(null)}
          onCommitTitle={(id, title) => {
            store.getState().dispatch(renameTopicCommand(id, title));
            store.getState().setEditing(null);
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
