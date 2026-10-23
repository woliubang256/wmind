import { zipSync } from 'fflate';
import type { EmbeddedFile } from '@/editor/model/types';

export const MAX_EMBEDDED_BYTES = 2 * 1024 * 1024;
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}

export async function embedFiles(files: readonly File[], folder = false): Promise<EmbeddedFile[]> {
  if (!files.length) return [];
  if (files.length > 100 || files.reduce((sum, file) => sum + file.size, 0) > MAX_EMBEDDED_BYTES) throw new Error('file-too-large');
  if (folder) {
    const entries: Record<string, Uint8Array> = Object.create(null);
    for (const file of files) {
      const path = file.webkitRelativePath || file.name;
      if (path.split('/').some((part) => part === '..' || part === '.' || !part) || path.includes('\\') || path.startsWith('/')) throw new Error('invalid-file');
      entries[path] = new Uint8Array(await file.arrayBuffer());
    }
    const bytes = zipSync(entries); if (bytes.length > MAX_EMBEDDED_BYTES) throw new Error('file-too-large');
    return [{ id: crypto.randomUUID(), name: `${files[0].webkitRelativePath?.split('/')[0] || 'folder'}.zip`, kind: 'folder', bytes: bytes.length, data: bytesToBase64(bytes) }];
  }
  return Promise.all(files.map(async (file) => ({ id: crypto.randomUUID(), name: file.name, kind: 'file' as const, bytes: file.size, data: bytesToBase64(new Uint8Array(await file.arrayBuffer())) })));
}

export function downloadEmbedded(file: EmbeddedFile) {
  const bytes = Uint8Array.from(atob(file.data), (char) => char.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  const link = document.createElement('a'); link.href = url; link.download = file.name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
