/**
 * 把导图渲染成一张缩略图 PNG。
 *
 * 走的是**导出那条路**（同一套 `buildExportContext` + `ExportCanvas`），不是
 * 把画布上的 `<svg>` 序列化一份。两个理由：
 *
 * 1. 画布上是 `foreignObject` 编辑框、选区、折叠徽标、视口变换——截图要先
 *    把它们全摘掉，摘漏一个就会在缩略图里留下一块编辑器痕迹；
 * 2. 导出上下文已经是「内容包围盒 + 留白」的纯几何，尺寸可预测，`planThumbnail`
 *    才能按像素算倍率。
 *
 * **不内嵌字体**，这是与导出对话框唯一的有意差异。内嵌要读几百 KB 的分片并
 * 转 base64，而缩略图最宽 640px、正文只有 4~8px 高——字体度量差 16% 在这里
 * 不到 1.5px，看不出来。为看不见的差异让每次生成多下载几百 KB 不划算。
 *
 * 这个模块把 `react-dom/server` 带进了依赖图（约 65KB gzip），所以编辑器里
 * 必须**动态 import** 它，别静态引。
 */

import type { WmindDocument } from '@/editor/model/types';
import { DEFAULT_EXPORT_OPTIONS, buildExportContext, type ExportOptions } from '@/editor/export/context';
import { buildExportSvg } from '@/editor/export/svg';
import { rasterizeSvg } from '@/editor/export/raster';
import { planThumbnail } from './thumbnail-plan';

/**
 * 缩略图的导出选项。
 *
 * `brand` 关掉：640px 宽的图上，右下角那行「由 wmind 生成」只有 2px 高，
 * 纯粹是噪点；而且页脚会改变画布长宽比，让同一张图在卡片里忽高忽低。
 */
const THUMBNAIL_OPTIONS: ExportOptions = {
  ...DEFAULT_EXPORT_OPTIONS,
  format: 'png',
  scale: 1,
  padding: 32,
  aspect: 'auto',
  transparent: false,
  border: 'none',
  date: false,
  brand: false,
};

/**
 * 渲染缩略图。尺寸算不出来时返回 `null`（文档刚打开、布局还没就绪）。
 */
export async function renderThumbnailPng(
  document: WmindDocument,
  sheetId: string | null,
): Promise<Blob | null> {
  const ctx = buildExportContext(document, sheetId, THUMBNAIL_OPTIONS);
  const plan = planThumbnail(ctx.width, ctx.height);
  if (plan.width === 0) return null;

  const markup = buildExportSvg({ ...ctx, scale: plan.scale });
  return rasterizeSvg(markup, {
    width: plan.width,
    height: plan.height,
    format: 'png',
    background: ctx.background,
  });
}
