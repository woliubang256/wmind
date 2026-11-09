import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('AI lazy dependency discovery', () => {
  it('prebundles PDF.js at cold startup without importing it into the home page', () => {
    const config = readFileSync(new URL('../../../vite.config.ts', import.meta.url), 'utf8');
    const optimize = config.slice(config.indexOf('optimizeDeps:'), config.indexOf('build:'));
    expect(optimize).toContain("'pdfjs-dist'");
    const attachments = readFileSync(new URL('./attachments.ts', import.meta.url), 'utf8');
    expect(attachments).toContain("await import('./pdf')");
    expect(attachments).not.toMatch(/from ['"]pdfjs-dist/);
  });
});
