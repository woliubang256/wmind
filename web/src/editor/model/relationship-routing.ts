import type { RelationshipRouting } from './types';

export function parseRelationshipRouting(value: unknown): RelationshipRouting | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const point = (input: unknown) => {
    if (!input || typeof input !== 'object') return undefined;
    const { x, y } = input as Record<string, unknown>;
    return typeof x === 'number' && Number.isFinite(x) && typeof y === 'number' && Number.isFinite(y) ? { x, y } : undefined;
  };
  const input = value as Record<string, unknown>;
  const start = point(input.start);
  const end = point(input.end);
  return start && end ? { start, end } : undefined;
}
