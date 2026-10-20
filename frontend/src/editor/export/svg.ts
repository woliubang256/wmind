/**
 * 独立 SVG 的序列化。
 *
 * 用 `react-dom/server` 的 `renderToStaticMarkup` 而不是手写字符串拼接：
 * 导出的 SVG 必须与画布**同一套**元素生成函数（docs/06 §3.2），而画布是
 * React 组件树。手写一份字符串渲染器意味着两套样式逻辑，像素级一致就无从谈起。
 *
 * 代价是 `react-dom/server` 会进包（压缩后约 200KB，gzip 约 65KB）。可接受，
 * 但前提是它**必须待在导出那个懒加载 chunk 里**——`vite.config.ts` 的
 * `manualChunks` 专门把它从 react chunk 里摘了出来，否则首屏会白白多下载
 * 六十多 KB 的序列化器，而绝大多数访客根本不会点「导出」。
 *
 * 另一点：这里**不用 DOM**。`renderToStaticMarkup` 在 node 环境下就能跑，
 * 所以「导出的 SVG 里有什么」可以纯函数断言，不需要 jsdom。
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import type { ExportContext } from './context';
import { ExportCanvas } from './export-canvas';

/** 带 XML 声明。少了它，某些阅读器（尤其是桌面端的图片查看器）会当成 HTML。 */
export function buildExportSvg(ctx: ExportContext): string {
  const markup = renderToStaticMarkup(createElement(ExportCanvas, { ctx }));
  return `<?xml version="1.0" encoding="UTF-8"?>\n${markup}`;
}

/**
 * 转成 `data:` URL，供预览的 `<img>` 与后续的栅格化共用。
 *
 * 走 `encodeURIComponent` 而不是 `btoa(markup)`：SVG 里有中文（节点标题），
 * `btoa` 只接受 Latin-1，遇到中文直接抛 `InvalidCharacterError`。先转义成
 * UTF-8 字节序列再交给 `btoa` 才安全。
 */
export function svgDataUrl(markup: string): string {
  const utf8 = new TextEncoder().encode(markup);
  let binary = '';
  for (const byte of utf8) binary += String.fromCharCode(byte);
  return `data:image/svg+xml;base64,${btoa(binary)}`;
}

/**
 * 文件名。
 *
 * 去掉路径分隔符与 Windows 保留字符：标题是用户随手写的，`/` 会让下载直接
 * 失败（Safari 会把整串当路径），而空标题要有个兜底。
 */
export function exportFileName(title: string, extension: string): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  const base = cleaned === '' ? '未命名导图' : cleaned;
  return `${base}.${extension}`;
}
