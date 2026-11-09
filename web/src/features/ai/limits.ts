export const AI_LIMITS = {
  files: 5,
  fileBytes: 20 * 1024 ** 2,
  totalFileBytes: 30 * 1024 ** 2,
  textRunes: 100_000,
  images: 12,
  imageBytes: 8 * 1024 ** 2,
  requestBytes: 12 * 1024 ** 2,
  pdfPages: 20,
  imageEdge: 1600,
} as const;

export const AI_TEXT_EXTENSIONS: readonly string[] = ['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'yaml', 'yml', 'xml', 'log', 'ini', 'conf', 'toml'];
export const AI_ACCEPT = ['docx', 'xlsx', 'pdf', 'png', 'jpg', 'jpeg', 'webp', 'gif', ...AI_TEXT_EXTENSIONS].map((extension) => `.${extension}`).join(',');
export type AIFileErrorCode = 'unsupported' | 'fileSize' | 'totalSize' | 'fileCount' | 'parse' | 'empty' | 'textLimit' | 'imageLimit' | 'pdfPages' | 'encrypted' | 'zipLimit';

export class AIFileError extends Error {
  constructor(public readonly code: AIFileErrorCode, public readonly fileName = '') {
    super(code);
    this.name = 'AIFileError';
  }
}

export function fileExtension(name: string): string {
  return name.toLowerCase().split('.').pop() ?? '';
}

export function validateFiles(files: readonly Pick<File, 'name' | 'size'>[]): void {
  if (files.length > AI_LIMITS.files) throw new AIFileError('fileCount');
  let size = 0;
  for (const file of files) {
    if (!AI_ACCEPT.split(',').includes(`.${fileExtension(file.name)}`)) throw new AIFileError('unsupported', file.name);
    if (file.size > AI_LIMITS.fileBytes) throw new AIFileError('fileSize', file.name);
    size += file.size;
  }
  if (size > AI_LIMITS.totalFileBytes) throw new AIFileError('totalSize');
}

export function textLength(text: string): number { return Array.from(text).length; }
