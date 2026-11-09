import type { ContentPatch } from '@/editor/commands/content';
import type { Topic, WmindDocument } from '@/editor/model/types';
import type { InsertAction } from './insert-actions';
import { InsertTextDialog } from './insert-text-dialog';
import { InsertFileDialog } from './insert-file-dialog';
import { InsertVisualDialog } from './insert-visual-dialog';

export function InsertDialog(props: { action: InsertAction; topics: Topic[]; doc: WmindDocument; onSave(patch: ContentPatch): void; onClose(): void }) {
  if (['file', 'folder', 'attachment', 'image'].includes(props.action)) return <InsertFileDialog {...props} />;
  if (['sticker', 'illustration', 'equation'].includes(props.action)) return <InsertVisualDialog {...props} />;
  return <InsertTextDialog {...props} />;
}
