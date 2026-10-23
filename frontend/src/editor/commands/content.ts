import { findTopicInSheet } from '../model/traverse';
import { parseTopicContent, safeTopicHref } from '../model/topic-content';
import type { Topic, TopicContent } from '../model/types';
import { defineCommand } from './types';

export type ContentPatch = Partial<Pick<Topic, 'notes' | 'labels' | 'href' | 'image'>> & { content?: Partial<TopicContent> };
export const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;

/** 同一批修改只产生一次历史；显式 undefined 删除 content 中的对应内容。 */
export function updateContentCommand(ids: readonly string[], patch: ContentPatch) {
  return defineCommand({
    type: 'topic.content', label: '修改主题内容',
    apply(draft, ctx) {
      const sheet = draft.sheets.find((item) => item.id === ctx.sheetId);
      if (!sheet || ids.length === 0) return;
      const topics = [...new Set(ids)].map((id) => findTopicInSheet(sheet, id)?.topic);
      if (topics.some((item) => !item)) return;
      if ((patch.content?.attachments?.length ?? 0) > 100) throw new Error('file-too-large');
      if (patch.href && !safeTopicHref(patch.href)) throw new Error('invalid-link');
      for (const topic of topics) {
        if (!topic) continue;
        if (patch.notes !== undefined) topic.notes = { plain: patch.notes.plain, html: '' };
        if (patch.labels !== undefined) topic.labels = [...new Set(patch.labels.map((item) => item.trim()).filter(Boolean))].slice(0, 30);
        if (patch.href !== undefined) topic.href = patch.href;
        if (patch.image !== undefined) topic.image = patch.image;
        if (patch.content !== undefined) {
          const content = parseTopicContent({ ...topic.content, ...patch.content });
          if (content) topic.content = content; else delete topic.content;
        }
      }
      if (new TextEncoder().encode(JSON.stringify(draft)).byteLength > MAX_DOCUMENT_BYTES) throw new Error('document-too-large');
    },
  });
}
