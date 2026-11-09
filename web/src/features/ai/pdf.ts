import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import workerURL from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { AIFileError, AI_LIMITS, textLength } from './limits';
import type { AISource } from './api';

GlobalWorkerOptions.workerSrc = workerURL;

// Vite emits local assets with hashed URLs. No CDN or PDF-specified URLs are used.
const resources: Record<string, Record<string, string>> = {
  cMapUrl: import.meta.glob<string>('/node_modules/pdfjs-dist/cmaps/*.bcmap', { eager: true, query: '?url', import: 'default' }),
  standardFontDataUrl: import.meta.glob<string>('/node_modules/pdfjs-dist/standard_fonts/*.{pfb,ttf}', { eager: true, query: '?url', import: 'default' }),
  wasmUrl: import.meta.glob<string>('/node_modules/pdfjs-dist/wasm/*.{wasm,js}', { eager: true, query: '?url', import: 'default' }),
};
const folders: Record<string, string> = { cMapUrl: 'cmaps', standardFontDataUrl: 'standard_fonts', wasmUrl: 'wasm' };
class LocalBinaryDataFactory {
  async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
    const url = resources[kind]?.[`/node_modules/pdfjs-dist/${folders[kind]}/${filename}`];
    if (!url) throw new AIFileError('parse');
    const response = await fetch(url);
    if (!response.ok) throw new AIFileError('parse');
    return new Uint8Array(await response.arrayBuffer());
  }
}

export async function extractPDF(bytes: Uint8Array, name: string, signal: AbortSignal): Promise<AISource> {
  signal.throwIfAborted();
  const task = getDocument({
    data: bytes, enableXfa: false, useWorkerFetch: false,
    BinaryDataFactory: LocalBinaryDataFactory, stopAtErrors: true,
    maxImageSize: 40_000_000, canvasMaxAreaInBytes: 16_000_000,
  });
  const abort = () => { void task.destroy().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    const pdf = await task.promise;
    if (pdf.numPages > AI_LIMITS.pdfPages) throw new AIFileError('pdfPages', name);
    const source: AISource = { name, text: '', images: [] };
    const pages: string[] = [];
    let characters = 0;
    for (let index = 1; index <= pdf.numPages; index += 1) {
      signal.throwIfAborted();
      const page = await pdf.getPage(index);
      const content = await page.getTextContent();
      const text = content.items.map((item) => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('').trim();
      characters += textLength(text);
      if (characters > AI_LIMITS.textRunes) throw new AIFileError('textLimit', name);
      if (text) {
        pages.push(`[${index}]\n${text}`);
      } else {
        if (source.images.length >= AI_LIMITS.images) throw new AIFileError('imageLimit', name);
        const unscaled = page.getViewport({ scale: 1 });
        const scale = Math.min(2, AI_LIMITS.imageEdge / Math.max(unscaled.width, unscaled.height));
        const viewport = page.getViewport({ scale });
        if (!Number.isFinite(viewport.width) || !Number.isFinite(viewport.height) || viewport.width < 1 || viewport.height < 1) throw new AIFileError('parse', name);
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const context = canvas.getContext('2d');
        if (!context) throw new AIFileError('parse', name);
        try {
          await page.render({ canvas, canvasContext: context, viewport, background: '#ffffff' }).promise;
          signal.throwIfAborted();
          source.images.push(canvas.toDataURL('image/jpeg', 0.85));
        } finally {
          canvas.width = 0; canvas.height = 0;
        }
      }
      page.cleanup();
    }
    source.text = pages.join('\n\n');
    return source;
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof Error && error.name === 'PasswordException') throw new AIFileError('encrypted', name);
    throw error;
  } finally {
    signal.removeEventListener('abort', abort);
    await task.destroy();
  }
}
