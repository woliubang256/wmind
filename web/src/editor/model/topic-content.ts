import type { TopicContent, EmbeddedFile, TopicTask } from './types';

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown, max = 2000) => typeof value === 'string' ? value.slice(0, max) : '';
const date = (value: unknown) => /^\d{4}-\d{2}-\d{2}$/.test(text(value)) ? text(value) : '';

export function safeTopicHref(value: string): boolean {
  if (/[\u0000-\u0020]/.test(value)) return false;
  if (/^xmind:#[^\s]+$/.test(value)) return true;
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? !!url.hostname : ['mailto:', 'tel:'].includes(url.protocol) && !!url.pathname; } catch { return false; }
}

export function parseEmbeddedFile(value: unknown): EmbeddedFile | undefined {
  const item = record(value);
  if (!text(item.id) || !text(item.name) || typeof item.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(item.data) || item.data.length > 3 * 1024 * 1024) return undefined;
  return { id: text(item.id), name: text(item.name, 255), data: item.data,
    bytes: Math.max(0, Math.min(2 * 1024 * 1024, Number(item.bytes) || 0)),
    kind: item.kind === 'folder' ? 'folder' : 'file' };
}

export function parseTask(value: unknown): TopicTask | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const task = record(value);
  return { progress: Math.max(0, Math.min(100, Math.round(Number(task.progress) || 0))),
    priority: Math.max(0, Math.min(5, Math.round(Number(task.priority) || 0))),
    assignee: text(task.assignee, 100), start: date(task.start), due: date(task.due) };
}

/** 新增字段集中清洗，原生解析与 XMind 自有扩展共用。 */
export function parseTopicContent(value: unknown): TopicContent | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = record(value); const out: TopicContent = {};
  if (typeof raw.todo === 'boolean') out.todo = raw.todo;
  const task = parseTask(raw.task); if (task) out.task = task;
  const localLink = parseEmbeddedFile(raw.localLink); if (localLink) out.localLink = localLink;
  if (Array.isArray(raw.attachments)) out.attachments = raw.attachments.slice(0, 100).map(parseEmbeddedFile).filter((item): item is EmbeddedFile => !!item);
  if (/^[a-z][a-z0-9-]{0,40}$/.test(text(raw.sticker))) out.sticker = text(raw.sticker);
  if (/^[a-z][a-z0-9-]{0,40}$/.test(text(raw.illustration))) out.illustration = text(raw.illustration);
  const equation = record(raw.equation);
  if (typeof equation.src === 'string' && equation.src.startsWith('data:image/svg+xml;base64,') && equation.src.length < 500_000 && text(equation.latex)) {
    out.equation = { latex: text(equation.latex), src: equation.src,
      width: Math.max(1, Math.min(1000, Number(equation.width) || 120)), height: Math.max(1, Math.min(1000, Number(equation.height) || 40)) };
  }
  return Object.keys(out).length ? out : undefined;
}
