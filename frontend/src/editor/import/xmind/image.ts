/**
 * 图片引用的解析：`xap:resources/a.png` → 待上传的 asset。
 *
 * XMind 现代格式把图片放在 `<topic>.image`，XMind 8 把它放在备注富文本的
 * `<img>` 里。两处的 `src` 写法、条目定位、格式白名单完全一致，所以这段
 * 逻辑抽出来共用。
 *
 * 一个前提：**解析是同步的、上传是异步的**。这里只把字节登记到 `ctx.asset()`，
 * `src` 先留原始引用当占位符，等 `finalize.ts` 换成服务端 URL。留占位符而
 * 不是直接丢掉，是因为「没上传成功」和「压根没这张图」要区分得开。
 */

import type { TopicImage } from '../../model/types';
import type { ImportContext } from '../types';

/** 图片扩展名 → MIME。不在表里的（svg 等）一律不收。 */
const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

/** 图片默认尺寸：XMind 没给宽高时用，与 Markdown 导入保持一致。 */
export const DEFAULT_IMAGE_WIDTH = 120;
export const DEFAULT_IMAGE_HEIGHT = 80;

/**
 * 把 `xap:resources/a.png` / `resources/a.png` 归一成 zip 条目名。
 *
 * 只做前缀剥离与斜杠规整，**不做 URL 解码**：条目名按原样匹配，解出来的
 * 名字反而可能对不上（`%20` 与空格在 zip 里就是两个不同的键）。
 */
export function normalizeResourcePath(src: string): string {
  let path = src.trim();
  if (path.toLowerCase().startsWith('xap:')) path = path.slice(4);
  path = path.replace(/^\/+/, '').replace(/^\.\//, '');
  return path;
}

/** 读一个尺寸值：只认正有限数，其余当「没给」。 */
export function toImageSize(raw: unknown): number {
  const value = typeof raw === 'number' ? raw : Number.parseFloat(String(raw ?? ''));
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

export interface ImageSource {
  /** XMind 里的原始引用：`xap:resources/a.png`、`resources/a.png` 或 `https://…`。 */
  src: string;
  width?: unknown;
  height?: unknown;
}

/**
 * 把一条 `src` 变成可用的 `TopicImage`，顺手把包内图片登记为待上传资源。
 *
 * 三种写法：`xap:resources/a.png`（包内）、`resources/a.png`（包内）、
 * `https://…`（外链）。外链直接用；包内的交给 `ctx.asset()`。
 *
 * 返回 null 表示这张图**没法还原**（条目不在包里、扩展名不支持、超过
 * `maxAssets`），调用方计入 `image-skipped`——不写一个指向 `xap:` 的坏引用。
 */
export function imageFromSource(
  source: ImageSource,
  ctx: ImportContext,
  resources: ReadonlyMap<string, Uint8Array>,
): TopicImage | null {
  const src = source.src.trim();
  if (src === '') return null;

  const width = toImageSize(source.width) || DEFAULT_IMAGE_WIDTH;
  const height = toImageSize(source.height) || DEFAULT_IMAGE_HEIGHT;

  if (/^https?:\/\//i.test(src)) return { src, width, height };

  const entry = normalizeResourcePath(src);
  const bytes = entry === '' ? undefined : resources.get(entry);
  if (bytes === undefined) return null;

  const dot = entry.lastIndexOf('.');
  const ext = dot < 0 ? '' : entry.slice(dot + 1).toLowerCase();
  const mime = IMAGE_MIME[ext];
  if (mime === undefined) return null;

  if (!ctx.asset({ ref: src, bytes, fileName: entry, mime })) return null;
  return { src, width, height };
}
