export type InsertAction = 'note' | 'label' | 'todo' | 'task' | 'web' | 'topic' | 'file' | 'folder' | 'attachment' | 'sticker' | 'illustration' | 'image' | 'equation';
export const INSERT_ACTIONS: InsertAction[] = ['note', 'label', 'todo', 'task', 'web', 'topic', 'file', 'folder', 'attachment', 'sticker', 'illustration', 'image', 'equation'];
const SINGLE = new Set<InsertAction>(['note', 'task', 'web', 'topic', 'file', 'folder', 'attachment', 'equation']);

export function insertAvailability(action: InsertAction, topics: number, selection: number): 'selection' | 'topics' | 'single' | null {
  if (!selection) return 'selection';
  if (topics !== selection) return 'topics';
  if (SINGLE.has(action) && topics !== 1) return 'single';
  return null;
}
