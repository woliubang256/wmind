/**
 * 模板卡片上的实时预览。
 *
 * 不用截图而用真渲染：截图要么随包发布一张 PNG（改模板就得重出图），要么
 * 在打开对话框时逐张栅格化（8 张 640px 的画布，首帧明显卡一下）。直接渲染
 * 一份 10 个节点的 SVG 既便宜，也永远和「用这个模板建出来的图」一致。
 *
 * 两件事必须由调用方保证：
 * - 字体已就绪（`useFontsReady`）。测量缓存里没有「字体到没到」这一维，
 *   用回退字体量出来的宽度会被永久缓存。
 * - 预览不接收指针事件。它只是张图，不该能被拖动或缩放。
 */

import { useMemo } from 'react';
import { layoutMindmap } from '@/editor/layout/mindmap';
import type { WmindDocument } from '@/editor/model/types';
import { MindMapViewer } from '@/editor/viewer/mind-map-viewer';

export interface TemplatePreviewProps {
  document: WmindDocument;
  /** 预览框的像素尺寸。布局按这个尺寸算缩放比，所以必须是确定的数字。 */
  width: number;
  height: number;
  label: string;
}

export function TemplatePreview({ document, width, height, label }: TemplatePreviewProps) {
  const sheet = document.sheets[0];
  const theme = document.theme;

  const layout = useMemo(
    () => (sheet ? layoutMindmap({ sheet, theme }) : null),
    [sheet, theme],
  );

  /**
   * 把包围盒居中塞进预览框。
   *
   * 缩放上限是 1：小模板不该被放大到糊——一个只有 3 个节点的骨架撑满卡片
   * 反而看不出层次。
   */
  const viewport = useMemo(() => {
    if (!layout) return { x: 0, y: 0, zoom: 1 };
    const { x, y, width: boxWidth, height: boxHeight } = layout.bounds;
    if (boxWidth <= 0 || boxHeight <= 0) return { x: 0, y: 0, zoom: 1 };
    const zoom = Math.min(width / boxWidth, height / boxHeight, 1);
    return {
      x: (width - boxWidth * zoom) / 2 - x * zoom,
      y: (height - boxHeight * zoom) / 2 - y * zoom,
      zoom,
    };
  }, [layout, width, height]);

  if (!sheet || !layout) return null;

  return (
    <div
      className="pointer-events-none overflow-hidden rounded-xl"
      style={{ width, height }}
      aria-hidden="true"
    >
      <MindMapViewer
        sheet={sheet}
        theme={theme}
        layout={layout}
        readOnly
        initialViewport={viewport}
        ariaLabel={label}
      />
    </div>
  );
}
