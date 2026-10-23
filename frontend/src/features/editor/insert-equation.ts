import { mathjax } from 'mathjax-full/js/mathjax.js';
import { TeX } from 'mathjax-full/js/input/tex.js';
import { SVG } from 'mathjax-full/js/output/svg.js';
import { liteAdaptor } from 'mathjax-full/js/adaptors/liteAdaptor.js';
import type { LiteElement } from 'mathjax-full/js/adaptors/lite/Element.js';
import { RegisterHTMLHandler } from 'mathjax-full/js/handlers/html.js';
import 'mathjax-full/js/input/tex/ams/AmsConfiguration.js';
import { bytesToBase64 } from './insert-files';
import type { TopicContent } from '@/editor/model/types';

const adaptor = liteAdaptor(); RegisterHTMLHandler(adaptor);
const input = new TeX({ packages: ['base', 'ams'], maxBuffer: 4000, maxMacros: 500,
  formatError: (_jax: unknown, error: Error) => { throw error; } });
const output = new SVG({ fontCache: 'none' });
const document = mathjax.document('', { InputJax: input, OutputJax: output });

/** 不使用 HTML/foreignObject，公式的字形路径可在图片和 PDF 导出中保留。 */
export function renderEquation(latex: string): NonNullable<TopicContent['equation']> {
  if (!latex.trim() || latex.length > 2000) throw new Error('equation');
  try {
    const container = document.convert(latex.trim(), { display: true });
    const svg = adaptor.firstChild(container) as LiteElement;
    if (!svg || adaptor.kind(svg) !== 'svg') throw new Error('equation');
    const viewBox: number[] = String(adaptor.getAttribute(svg, 'viewBox') || '').split(/\s+/).map(Number);
    if (viewBox.length !== 4 || viewBox.some((n) => !Number.isFinite(n)) || viewBox[2] <= 0 || viewBox[3] <= 0) throw new Error('equation');
    const width = Math.max(12, Math.ceil(viewBox[2] * .022)), height = Math.max(20, Math.ceil(viewBox[3] * .022));
    adaptor.setAttribute(svg, 'width', String(width)); adaptor.setAttribute(svg, 'height', String(height));
    adaptor.setAttribute(svg, 'color', '#1F2937');
    const raw = adaptor.outerHTML(svg).replace(/(<svg[^>]*>)/, `$1<rect x="${viewBox[0]}" y="${viewBox[1]}" width="${viewBox[2]}" height="${viewBox[3]}" fill="white"/>`);
    if (raw.includes('data-mjx-error') || raw.length > 350_000) throw new Error('equation');
    return { latex: latex.trim(), src: 'data:image/svg+xml;base64,' + bytesToBase64(new TextEncoder().encode(raw)), width, height };
  } catch { throw new Error('equation'); }
}
