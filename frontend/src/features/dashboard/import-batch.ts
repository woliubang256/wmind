import { importRegistry } from '@/editor/import/builtins';
import { ImportError } from '@/editor/import/errors';
import { finalizeImport, type AssetUploader } from '@/editor/import/finalize';
import { IMPORT_LIMITS } from '@/editor/import/limits';
import type { ImportResult } from '@/editor/import/types';
import type { WmindDocument } from '@/editor/model/types';

export interface ImportBatchSource {
  name: string;
  size: number;
  read: () => Promise<Uint8Array>;
}

export interface PreparedImport {
  fileName: string;
  size: number;
  result: ImportResult | null;
  error?: unknown;
  createdUid?: string;
  createError?: unknown;
}

export type ImportProgress =
  | { kind: 'parsing'; fileName: string; index: number; totalFiles: number }
  | { kind: 'uploading'; fileName: string; size: number; done: number; total: number; index: number; totalFiles: number };

interface PrepareOptions {
  isCurrent: () => boolean;
  upload: AssetUploader;
  onProgress: (progress: ImportProgress) => void;
}

/** Sequential reading bounds ZIP memory; every source retains its position even on failure. */
export async function prepareImportBatch(sources: readonly ImportBatchSource[], options: PrepareOptions): Promise<PreparedImport[] | null> {
  const items: PreparedImport[] = [];
  let uploadLimitError: unknown;
  for (const [index, source] of sources.entries()) {
    if (!options.isCurrent()) return null;
    const item: PreparedImport = { fileName: source.name, size: source.size, result: null };
    const progress = { fileName: source.name, index: index + 1, totalFiles: sources.length };
    options.onProgress({ kind: 'parsing', ...progress });
    try {
      if (source.size > IMPORT_LIMITS.maxInputBytes) throw new ImportError('FILE_TOO_LARGE', { size: source.size, limit: IMPORT_LIMITS.maxInputBytes });
      // Give progress a chance to paint before synchronous ZIP/Markdown parsing.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      if (!options.isCurrent()) return null;
      const bytes = await source.read();
      if (!options.isCurrent()) return null;
      const parsed = importRegistry.run({ fileName: source.name, bytes });
      if (parsed.assets.length > 0) options.onProgress({ kind: 'uploading', ...progress, size: source.size, done: 0, total: parsed.assets.length });
      const outcome = await finalizeImport(parsed, {
        upload: async (asset) => {
          if (!options.isCurrent()) throw new DOMException('Import cancelled', 'AbortError');
          if (uploadLimitError !== undefined) throw uploadLimitError;
          try { return await options.upload(asset); }
          catch (error) {
            if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'RATE_LIMITED') uploadLimitError = error;
            throw error;
          }
        },
        onProgress: (done, total) => {
          if (options.isCurrent()) options.onProgress({ kind: 'uploading', ...progress, size: source.size, done, total });
        },
      });
      if (!options.isCurrent()) return null;
      item.result = outcome.result;
    } catch (error) {
      if (!options.isCurrent()) return null;
      item.error = error;
    }
    items.push(item);
  }
  return options.isCurrent() ? items : null;
}

/** Successful items retain their uid across explicit retries; no automatic request replay. */
export async function createImportBatch(
  items: readonly PreparedImport[],
  create: (input: { title: string; document: WmindDocument }) => Promise<{ uid: string }>,
  isCurrent: () => boolean,
  onItem: (index: number, item: PreparedImport) => void,
): Promise<PreparedImport[] | null> {
  const completed = items.slice();
  for (const [index, item] of items.entries()) {
    if (!isCurrent()) return null;
    if (!item.result || item.createdUid) continue;
    let next: PreparedImport;
    try {
      const created = await create({ title: item.result.document.title, document: item.result.document });
      next = { ...item, createdUid: created.uid, createError: undefined };
    } catch (createError) { next = { ...item, createError }; }
    if (!isCurrent()) return null;
    completed[index] = next;
    onItem(index, next);
  }
  return isCurrent() ? completed : null;
}
