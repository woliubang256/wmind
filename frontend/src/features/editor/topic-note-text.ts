import type { Topic } from '@/editor/model/types';
import { sanitizeNotesHtml } from '@/editor/import/html';

/** 查看与纯文本编辑使用同一转换，导入的 HTML 备注不会在编辑时变成空白。 */
export function topicNoteText(notes: Topic['notes']): string {
  if (notes.plain || !notes.html) return notes.plain;
  const html = sanitizeNotesHtml(notes.html).replace(/<br\s*\/?\s*>|<\/(?:p|div|li|tr|h[1-6])>/gi, '\n');
  return new DOMParser().parseFromString(html, 'text/html').body.textContent?.trim() ?? '';
}
