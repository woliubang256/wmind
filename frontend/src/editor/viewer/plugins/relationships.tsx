import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { Point } from '../../layout/types';
import type { RelationshipRouting } from '../../model/types';
import { useViewer } from '../viewer-context';
import { useLatest } from './use-latest';

/** 联系命中与控制柄独立于主题选区；拖动预览不写入文档历史。 */
export function RelationshipsPlugin() {
  const context = useViewer();
  const { svgRef, readOnly, annotations, selectedAnnotationId, viewport } = context;
  const latest = useLatest(context);
  const { t } = useTranslation();

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || readOnly) return;
    let drag: { id: string; index: number; points: Point[]; pointerId: number; curve: boolean; routing: RelationshipRouting | null } | null = null;
    const idOf = (event: Event) => {
      const element = (event.target as Element | null)?.closest('[data-relationship-id], [data-routing-relationship-id]');
      return element?.getAttribute('data-relationship-id') ?? element?.getAttribute('data-routing-relationship-id');
    };
    const controlOf = (event: Event) => (event.target as Element | null)?.closest('[data-relationship-control]');
    const routingAt = (id: string, points: Point[], index: number, point: Point): RelationshipRouting | null => {
      const view = latest.current;
      const relationship = view.sheet.relationships.find((item) => item.id === id);
      const a = relationship && view.layout.boxes.get(relationship.end1Id);
      const b = relationship && view.layout.boxes.get(relationship.end2Id);
      if (!a || !b) return null;
      const next = points.map((entry, i) => i === index ? point : entry);
      const start = next[0], end = next[1] ?? next[0];
      return { start: { x: start.x - a.x - a.width / 2, y: start.y - a.y - a.height / 2 },
        end: { x: end.x - b.x - b.width / 2, y: end.y - b.y - b.height / 2 } };
    };
    const cancel = () => {
      if (!drag) return;
      const old = drag; drag = null;
      latest.current.previewRelationshipRouting(old.id, null);
      if (svg.hasPointerCapture(old.pointerId)) svg.releasePointerCapture(old.pointerId);
    };
    const onPointerDown = (event: PointerEvent) => {
      const id = idOf(event);
      if (!id || event.button !== 0) return;
      event.preventDefault(); event.stopPropagation();
      const control = controlOf(event);
      const item = latest.current.annotations.relationships.find((entry) => entry.id === id);
      if (control && item) {
        drag = { id, index: Number(control.getAttribute('data-relationship-control')), points: item.controls,
          pointerId: event.pointerId, curve: item.lineStyle === 'straight', routing: null };
        (control as SVGElement).focus();
        svg.setPointerCapture(event.pointerId);
      } else latest.current.selectRelationship(id);
    };
    const onMove = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      event.preventDefault(); event.stopPropagation();
      if (latest.current.selectedAnnotationId !== drag.id) { cancel(); return; }
      drag.routing = routingAt(drag.id, drag.points, drag.index, latest.current.toWorld(event.clientX, event.clientY));
      if (drag.routing) latest.current.previewRelationshipRouting(drag.id, drag.routing, drag.curve);
    };
    const onUp = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      event.preventDefault(); event.stopPropagation();
      const old = drag; drag = null;
      if (svg.hasPointerCapture(old.pointerId)) svg.releasePointerCapture(old.pointerId);
      if (old.routing) latest.current.commitRelationshipRouting(old.id, old.routing, old.curve);
      else latest.current.previewRelationshipRouting(old.id, null);
    };
    const onDoubleClick = (event: MouseEvent) => {
      const id = idOf(event);
      if (!id) return;
      event.preventDefault(); event.stopPropagation();
      if (!controlOf(event)) latest.current.beginRelationshipEdit(id);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (drag && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel(); return; }
      const id = idOf(event);
      if (!id) return;
      const control = controlOf(event);
      if (control && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
        event.preventDefault(); event.stopPropagation();
        const item = latest.current.annotations.relationships.find((entry) => entry.id === id);
        const index = Number(control.getAttribute('data-relationship-control'));
        const point = item?.controls[index];
        if (!item || !point) return;
        const step = event.shiftKey ? 1 : 10;
        const routing = routingAt(id, item.controls, index, { x: point.x + (event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0),
          y: point.y + (event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0) });
        if (routing) latest.current.commitRelationshipRouting(id, routing, item.lineStyle === 'straight');
      } else if (!control && ['Enter', 'F2', ' '].includes(event.key)) {
        event.preventDefault(); event.stopPropagation();
        if (event.key === ' ') latest.current.selectRelationship(id);
        else latest.current.beginRelationshipEdit(id);
      }
    };
    svg.addEventListener('pointerdown', onPointerDown, true);
    svg.addEventListener('dblclick', onDoubleClick, true);
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', cancel, true);
    window.addEventListener('blur', cancel);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      cancel();
      svg.removeEventListener('pointerdown', onPointerDown, true);
      svg.removeEventListener('dblclick', onDoubleClick, true);
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', cancel, true);
      window.removeEventListener('blur', cancel);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [svgRef, readOnly, latest]);

  const selected = annotations.relationships.find((item) => item.id === selectedAnnotationId);
  if (readOnly || !selected) return null;
  return <g className="relationship-controls" data-routing-relationship-id={selected.id}>
    {selected.controls.map((point, index) => <g key={index}>
      {selected.controls.length === 2 ? <line x1={index === 0 ? selected.from.x : selected.to.x} y1={index === 0 ? selected.from.y : selected.to.y}
        x2={point.x} y2={point.y} stroke="#2563EB" strokeWidth={1 / viewport.zoom} strokeDasharray={`${4 / viewport.zoom} ${3 / viewport.zoom}`} pointerEvents="none" /> : null}
      <circle data-relationship-control={index} cx={point.x} cy={point.y} r={6 / viewport.zoom} fill="#FFFFFF" stroke="#2563EB" strokeWidth={2 / viewport.zoom}
        role="button" tabIndex={0} aria-label={t('editor.annotation.routingControl', { index: index + 1 })}
        className="cursor-move outline-none focus:fill-blue-200"><title>{t('editor.annotation.routingHint')}</title></circle>
    </g>)}
  </g>;
}
