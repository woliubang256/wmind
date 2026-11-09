import { mapMarker } from '../import/markers';
import { findTopicInSheet } from '../model/traverse';
import { defineCommand, type EditorCommand } from './types';

/** 混合选区统一应用，全部已有相同标记时统一移除。 */
export function toggleMarkerCommand(ids: readonly string[], markerId: string): EditorCommand {
  return defineCommand({ type: 'topic.marker', label: '修改主题标记', apply(draft, ctx) {
    const sheet = draft.sheets.find((item) => item.id === ctx.sheetId);
    const marker = mapMarker(markerId);
    if (!sheet || !marker) return;
    const topics = [...new Set(ids)].map((id) => findTopicInSheet(sheet, id)?.topic).filter((topic) => topic !== undefined);
    if (topics.length === 0) return;
    const remove = topics.every((topic) => topic.markers.some((item) => item.markerId === markerId));
    for (const topic of topics) {
      const next = topic.markers.filter((item) => item.groupId !== marker.groupId);
      if (!remove) next.push({ ...marker });
      if (JSON.stringify(topic.markers) !== JSON.stringify(next)) topic.markers = next;
    }
  } });
}

export function clearMarkersCommand(ids: readonly string[]): EditorCommand {
  return defineCommand({ type: 'topic.markers.clear', label: '清空主题标记', apply(draft, ctx) {
    const sheet = draft.sheets.find((item) => item.id === ctx.sheetId);
    if (!sheet) return;
    for (const id of new Set(ids)) {
      const topic = findTopicInSheet(sheet, id)?.topic;
      if (topic?.markers.length) topic.markers = [];
    }
  } });
}
