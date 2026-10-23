import type { Topic } from '../model/types';
import { safeTopicHref } from '../model/topic-content';
import { artwork } from '../model/insert-artwork';
import { measureText, type FontSpec, type MeasureBackend } from './measure';

export interface DetailLine { kind: 'note' | 'label' | 'todo' | 'task' | 'link' | 'attachment'; text: string; title: string; id?: string; href?: string; download?: string }
export interface TopicDetails {
  lines: DetailLine[];
  media: { kind: 'sticker' | 'illustration' | 'equation'; src: string; width: number; height: number }[];
  height: number;
  width: number;
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
  for (const label of topic.labels) add('label', `# ${label}`);
  if (topic.notes.plain || topic.notes.html) add('note', '≡', topic.notes.plain || '…');
  const content = topic.content;
  if (typeof content?.todo === 'boolean') add('todo', content.todo ? '☑' : '☐');
  if (content?.task) {
    const task = content.task;
    add('task', [task.progress + '%', task.priority ? 'P' + task.priority : '', task.assignee, [task.start, task.due].filter(Boolean).join(' → ')].filter(Boolean).join(' · '));
  }
  if (content?.localLink) {
    const file = content.localLink;
    add('link', `↗ ${file.name}`, file.name, { href: `data:application/octet-stream;base64,${file.data}`, download: file.name });
  } else if (topic.href && safeTopicHref(topic.href)) {
    const internal = topic.href.startsWith('xmind:#');
    const title = internal ? linkedTopicTitle || '' : topic.href.replace(/^https?:\/\//, '');
    add('link', `↗ ${title}`.trim(), title, { href: internal ? undefined : topic.href });
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
  if (!lines.length && !media.length) return undefined;
  return { lines, media, width, height: 8 + lines.length * 20 + media.reduce((sum, item) => sum + item.height + 8, 0) };
}
