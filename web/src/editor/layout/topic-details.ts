import type { Topic } from '../model/types';
import { safeTopicHref } from '../model/topic-content';
import { artwork } from '../model/insert-artwork';
import { measureText, type FontSpec, type MeasureBackend } from './measure';

export interface DetailLine { kind: 'task' | 'attachment'; text: string; title: string; id?: string; href?: string; download?: string }
export interface LabelBadge { title: string; lines: string[]; x: number; y: number; width: number; height: number }
export interface TopicDetails {
  todo?: boolean;
  entry?: { kind: 'note' | 'link' | 'more'; title: string; href?: string; download?: string };
  rowWidth: number;
  badges: LabelBadge[];
  labelHeight: number;
  lines: DetailLine[];
  media: { kind: 'sticker' | 'illustration' | 'equation'; src: string; width: number; height: number }[];
  /** 任务、附件和媒体在形状内部占用的高度。主行和外置标签不计入。 */
  height: number;
  width: number;
}

export const DETAIL_CONTROL_SIZE = 16;
export const DETAIL_CONTROL_SPACE = 24;
const LABEL_FONT: FontSpec = { family: 'sans', size: 11, weight: 400, italic: false };

export function layoutLabelBadges(labels: readonly string[], width: number, impl: MeasureBackend): { badges: LabelBadge[]; labelHeight: number } {
  let x = 0; let y = 6; let rowHeight = 0;
  const badges = labels.map((title) => {
    const measured = measureText(title, LABEL_FONT, Math.max(1, width - 12), impl);
    const badgeWidth = Math.min(width, Math.max(16, measured.width + 12));
    const height = measured.lines.length * 14 + 6;
    if (x > 0 && x + badgeWidth > width) { x = 0; y += rowHeight + 4; rowHeight = 0; }
    const badge = { title, lines: measured.lines, x, y, width: badgeWidth, height };
    x += badgeWidth + 4; rowHeight = Math.max(rowHeight, height);
    return badge;
  });
  return { badges, labelHeight: labels.length ? y + rowHeight : 0 };
}

export function measureDetails(topic: Topic, available: number, impl: MeasureBackend, linkedTopicTitle?: string): TopicDetails | undefined {
  const lines: DetailLine[] = [];
  const font: FontSpec = { family: 'sans', size: 12, weight: 400, italic: false };
  let width = 0;
  const add = (kind: DetailLine['kind'], text: string, title = text, extra: Partial<DetailLine> = {}) => {
    const measured = measureText(text, font, available, impl);
    width = Math.max(width, measured.width);
    for (const line of measured.lines) lines.push({ kind, text: line, title, ...extra });
  };
  const hasNote = Boolean(topic.notes.plain || topic.notes.html);
  const content = topic.content;
  let link: TopicDetails['entry'];
  if (content?.localLink) {
    const file = content.localLink;
    link = { kind: 'link', title: file.name, href: `data:application/octet-stream;base64,${file.data}`, download: file.name };
  } else if (topic.href && safeTopicHref(topic.href)) {
    const internal = topic.href.startsWith('xmind:#');
    link = { kind: 'link', title: internal ? linkedTopicTitle || '…' : topic.href.replace(/^https?:\/\//, ''), href: internal ? undefined : topic.href };
  }
  const entry: TopicDetails['entry'] = hasNote && link ? { ...link, kind: 'more', title: topic.notes.plain || link.title }
    : hasNote ? { kind: 'note', title: topic.notes.plain || '…' } : link;
  const todo = typeof content?.todo === 'boolean' ? content.todo : undefined;
  if (content?.task) {
    const task = content.task;
    add('task', [task.progress + '%', task.priority ? 'P' + task.priority : '', task.assignee, [task.start, task.due].filter(Boolean).join(' → ')].filter(Boolean).join(' · '));
  }
  for (const file of content?.attachments ?? []) add('attachment', `⌕ ${file.name}`, file.name, { id: file.id, href: `data:application/octet-stream;base64,${file.data}`, download: file.name });
  const media: TopicDetails['media'] = [];
  for (const kind of ['sticker', 'illustration'] as const) {
    const asset = content?.[kind] ? artwork(kind, content[kind]!) : null;
    if (asset) media.push({ kind, ...asset });
  }
  if (content?.equation) media.push({ kind: 'equation', ...content.equation });
  for (const item of media) {
    const scale = Math.min(1, available / item.width, 180 / item.height);
    item.width *= scale; item.height *= scale; width = Math.max(width, item.width);
  }
  for (const label of topic.labels) width = Math.max(width, Math.min(available, measureText(label, LABEL_FONT, available - 12, impl).width + 12));
  if (!lines.length && !media.length && !topic.labels.length && todo === undefined && !entry) return undefined;
  const height = lines.length || media.length ? 8 + lines.length * 20 + media.reduce((sum, item) => sum + item.height + 8, 0) : 0;
  return { todo, entry, rowWidth: 0, badges: [], labelHeight: 0, lines, media, width, height };
}
