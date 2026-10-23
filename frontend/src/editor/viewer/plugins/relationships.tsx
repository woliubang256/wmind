import { useEffect } from 'react';
import { useViewer } from '../viewer-context';
import { useLatest } from './use-latest';

/** 联系独立于主题选区；捕获命中后不再启动框选或主题快捷键。 */
export function RelationshipsPlugin() {
  const { svgRef, readOnly } = useViewer();
  const latest = useLatest(useViewer());

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || readOnly) return undefined;
    const idOf = (event: Event) => (event.target as Element | null)?.closest('[data-relationship-id]')?.getAttribute('data-relationship-id');
    const onPointerDown = (event: PointerEvent) => {
      const id = idOf(event);
      if (!id || event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      latest.current.selectRelationship(id);
    };
    const onDoubleClick = (event: MouseEvent) => {
      const id = idOf(event);
      if (!id) return;
      event.preventDefault();
      event.stopPropagation();
      latest.current.beginRelationshipEdit(id);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const id = idOf(event);
      if (!id || !['Enter', 'F2', ' '].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === ' ') latest.current.selectRelationship(id);
      else latest.current.beginRelationshipEdit(id);
    };
    svg.addEventListener('pointerdown', onPointerDown, true);
    svg.addEventListener('dblclick', onDoubleClick, true);
    svg.addEventListener('keydown', onKeyDown, true);
    return () => {
      svg.removeEventListener('pointerdown', onPointerDown, true);
      svg.removeEventListener('dblclick', onDoubleClick, true);
      svg.removeEventListener('keydown', onKeyDown, true);
    };
  }, [svgRef, readOnly, latest]);
  return null;
}
