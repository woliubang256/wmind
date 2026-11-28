import { useMemo, useRef, useState } from 'react';
import { produce } from 'immer';
import { useTranslation } from 'react-i18next';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { LoadingState } from '@/components/ui/loading-state';
import { Select } from '@/components/ui/select';
import { parseDocument } from '@/editor/model/validate';
import type { WmindDocument } from '@/editor/model/types';
import { findTopicInSheet } from '@/editor/model/traverse';
import { layoutMindmap } from '@/editor/layout/mindmap';
import type { LayoutResult } from '@/editor/layout/types';
import { layoutAnnotations, unionRect } from '@/editor/layout/annotations';
import { MindMapViewer } from '@/editor/viewer/mind-map-viewer';
import { READ_ONLY_PLUGINS } from '@/editor/viewer/plugins';
import { MAX_ZOOM, MIN_ZOOM, zoomedViewport } from '@/editor/viewer/plugins/pan-zoom';
import { CanvasScrollbars } from '@/features/editor/canvas-scrollbars';
import { centeredViewport } from '@/features/editor/canvas-navigation';
import { ToolbarButton } from '@/features/editor/toolbar-button';
import { useCanvasViewport } from '@/features/editor/use-canvas-viewport';
import { useFontsReady } from '@/features/editor/use-fonts-ready';

const PENDING_LAYOUT: LayoutResult = {
  boxes: new Map(),
  edges: [],
  sizes: new Map(),
  styles: new Map(),
  bounds: { x: 0, y: 0, width: 1, height: 1 },
};

export function XmindReadonlyDialog({
  open,
  title,
  document,
  onClose,
  onConvert,
}: {
  open: boolean;
  title: string;
  document: WmindDocument;
  onClose: () => void;
  onConvert: () => void;
}) {
  const { t } = useTranslation();
  const [viewDocument, setViewDocument] = useState(() => parseDocument(document).document);
  const [sheetId, setSheetId] = useState(() => viewDocument.viewState?.activeSheetId ?? viewDocument.sheets[0]!.id);
  const sheet = viewDocument.sheets.find((item) => item.id === sheetId) ?? viewDocument.sheets[0]!;
  const fonts = useFontsReady(viewDocument);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const layout = useMemo(
    () => fonts.ready ? layoutMindmap({ sheet, theme: viewDocument.theme }) : PENDING_LAYOUT,
    [fonts.generation, fonts.ready, sheet, viewDocument.theme],
  );
  const bounds = useMemo(() => {
    const annotations = layoutAnnotations(sheet, layout, sheet.themeOverride ?? viewDocument.theme);
    return unionRect([layout.bounds, ...(annotations.bounds ? [annotations.bounds] : [])], 16)!;
  }, [layout, sheet, viewDocument.theme]);
  const { viewport, setViewport, fit } = useCanvasViewport({
    canvasRef,
    sheetId: sheet.id,
    bounds,
    ready: fonts.ready,
  });
  const zoom = (factor: number) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (rect) setViewport((current) => zoomedViewport(current, factor, { x: rect.width / 2, y: rect.height / 2 }));
  };
  const toggleCollapse = (id: string) => setViewDocument((current) => produce(current, (draft) => {
    const target = draft.sheets.find((item) => item.id === sheet.id);
    const found = target && findTopicInSheet(target, id);
    if (found && (found.topic.children.attached.length || found.topic.children.detached.length)) found.topic.collapsed = !found.topic.collapsed;
  }));

  return (
    <Modal
      open={open}
      title={title}
      description={t('desktop.openFile.xmindViewDescription')}
      onClose={onClose}
      dismissible
      size="lg"
      footer={(
        <>
          <Button variant="outline" onClick={onClose}>{t('common.close')}</Button>
          <Button onClick={onConvert}><Icon name="file-plus" className="size-4" />{t('desktop.openFile.convert')}</Button>
        </>
      )}
    >
      <div className="flex h-[min(68svh,620px)] min-h-[360px] flex-col overflow-hidden rounded-xl border border-border/70 bg-background">
        <div ref={canvasRef} className="relative min-h-0 flex-1">
          {fonts.ready ? (
            <div id="open-file-canvas-surface" className="size-full">
              <MindMapViewer
                sheet={sheet}
                theme={viewDocument.theme}
                plugins={READ_ONLY_PLUGINS}
                layout={layout}
                viewport={viewport}
                onViewportChange={setViewport}
                onToggleCollapse={toggleCollapse}
                readOnly
                ariaLabel={title}
                className="size-full"
              />
              <CanvasScrollbars canvasRef={canvasRef} bounds={bounds} viewport={viewport} onChange={setViewport} surfaceId="open-file-canvas-surface" />
            </div>
          ) : <LoadingState className="size-full" />}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-1 border-t border-border/70 bg-card px-3 py-1.5">
          {viewDocument.sheets.length > 1 ? <Select aria-label={t('editor.sheets.label')} value={sheet.id} onChange={setSheetId} className="mr-auto w-40 max-w-full" size="sm" options={viewDocument.sheets.map((item) => ({ value: item.id, label: item.title }))} /> : null}
          <ToolbarButton variant="ghost" size="icon" className="size-8" aria-label={t('editor.zoomOut')} disabled={!fonts.ready || viewport.zoom <= MIN_ZOOM} onClick={() => zoom(1 / 1.2)}><Icon name="zoom-out" className="size-4" /></ToolbarButton>
          <span className="px-1 text-xs text-muted-foreground">{Math.round(viewport.zoom * 100)}%</span>
          <ToolbarButton variant="ghost" size="icon" className="size-8" aria-label={t('editor.zoomIn')} disabled={!fonts.ready || viewport.zoom >= MAX_ZOOM} onClick={() => zoom(1.2)}><Icon name="zoom-in" className="size-4" /></ToolbarButton>
          <ToolbarButton variant="ghost" size="icon" className="size-8" aria-label={t('editor.fit')} disabled={!fonts.ready} onClick={fit}><Icon name="maximize" className="size-4" /></ToolbarButton>
          <ToolbarButton variant="ghost" size="icon" className="size-8" aria-label={t('editor.centerTopic')} disabled={!fonts.ready} onClick={() => {
            const rect = canvasRef.current?.getBoundingClientRect();
            const root = layout.boxes.get(sheet.rootTopic.id);
            if (rect && root) setViewport((current) => centeredViewport(current, root, rect));
          }}><Icon name="locate" className="size-4" /></ToolbarButton>
        </div>
      </div>
    </Modal>
  );
}
