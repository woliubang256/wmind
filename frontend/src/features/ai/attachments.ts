import type { AISource } from './api';
import { AIFileError, AI_LIMITS, AI_TEXT_EXTENSIONS, fileExtension, textLength, validateFiles } from './limits';
import { extractDocx, extractXlsx } from './office';
import { extractText } from './text';

async function imageData(file: File, signal: AbortSignal): Promise<string> {
  const bitmap = await createImageBitmap(file);
  try {
    signal.throwIfAborted();
    if (bitmap.width * bitmap.height > 40_000_000) throw new AIFileError('fileSize', file.name);
    const ratio = Math.min(1, AI_LIMITS.imageEdge / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
    canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
    try {
      const context = canvas.getContext('2d');
      if (!context) throw new AIFileError('parse', file.name);
      context.fillStyle = '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/jpeg', 0.85);
    } finally {
      canvas.width = 0; canvas.height = 0;
    }
  } finally { bitmap.close(); }
}

export function validateSources(prompt: string, sources: AISource[]): void {
  if (textLength(prompt) + sources.reduce((sum, source) => sum + textLength(source.text), 0) > AI_LIMITS.textRunes) throw new AIFileError('textLimit');
  const images = sources.flatMap((source) => source.images);
  if (images.length > AI_LIMITS.images || images.some((url) => url.length > 3 * 1024 ** 2)
    || images.reduce((sum, url) => sum + Math.floor((url.length - url.indexOf(',') - 1) * 3 / 4), 0) > AI_LIMITS.imageBytes) throw new AIFileError('imageLimit');
  if (new TextEncoder().encode(JSON.stringify({ prompt, sources })).byteLength > AI_LIMITS.requestBytes) throw new AIFileError('imageLimit');
}

export async function extractAttachments(files: File[], prompt: string, signal: AbortSignal, onFile: (name: string) => void): Promise<AISource[]> {
  validateFiles(files);
  validateSources(prompt, []);
  const sources: AISource[] = [];
  for (const file of files) {
    signal.throwIfAborted();
    onFile(file.name);
    // Let React paint the file status before a bounded synchronous ZIP/XML parse.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    signal.throwIfAborted();
    try {
      const extension = fileExtension(file.name);
      let source: AISource;
      if (['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(extension)) {
        source = { name: file.name, text: '', images: [await imageData(file, signal)] };
      } else {
        const bytes = new Uint8Array(await file.arrayBuffer());
        signal.throwIfAborted();
        if (extension === 'pdf') {
          const { extractPDF } = await import('./pdf');
          signal.throwIfAborted();
          source = await extractPDF(bytes, file.name, signal);
        } else if (AI_TEXT_EXTENSIONS.includes(extension)) {
          source = { name: file.name, text: extractText(bytes), images: [] };
        } else if (extension === 'docx' || extension === 'xlsx') {
          source = { name: file.name, text: extension === 'docx' ? extractDocx(bytes) : extractXlsx(bytes), images: [] };
        } else throw new AIFileError('unsupported', file.name);
      }
      signal.throwIfAborted();
      if (!source.text.trim() && !source.images.length) throw new AIFileError('empty', file.name);
      sources.push(source);
      validateSources(prompt, sources);
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof AIFileError) throw new AIFileError(error.code, error.fileName || file.name);
      throw new AIFileError('parse', file.name);
    }
  }
  return sources;
}
