import type { CanvasView, DocumentViewState } from './types';

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export function isCanvasView(value: unknown): value is CanvasView {
  return record(value) && ['centerX', 'centerY', 'zoom'].every((key) => typeof value[key] === 'number' && Number.isFinite(value[key]))
    && Math.abs(value.centerX as number) <= 1e9 && Math.abs(value.centerY as number) <= 1e9
    && (value.zoom as number) >= 0.2 && (value.zoom as number) <= 4;
}

/** 只保留存在画布的有限视图；坏视图不影响文档内容。 */
export function parseViewState(value: unknown, sheetIds: readonly string[]): DocumentViewState | undefined {
  if (!record(value)) return undefined;
  const activeSheetId = typeof value.activeSheetId === 'string' && sheetIds.includes(value.activeSheetId)
    ? value.activeSheetId : sheetIds[0]!;
  const views = record(value.sheets) ? value.sheets : {};
  const sheets = Object.fromEntries(sheetIds.flatMap((id) => Object.hasOwn(views, id) && isCanvasView(views[id]) ? [[id, views[id]]] : []));
  return { activeSheetId, sheets };
}
