import type { ComputedStyle } from '../model/types';
import type { ImageSize, MarkerLayout, NodeBox } from './types';
import type { TopicDetails } from './topic-details';
import { DETAIL_CONTROL_SIZE, DETAIL_CONTROL_SPACE } from './topic-details';
import { NODE_METRICS } from './constants';

/** 主行、图片、正文和外置标签共享几何；HTML 编辑框只覆盖标题区域。 */
export function topicContentGeometry(box: NodeBox, style: ComputedStyle, lines: readonly string[], image: ImageSize | null, markers?: MarkerLayout, details?: TopicDetails) {
  const lineHeight = Math.round(style.fontSize * NODE_METRICS.lineHeightRatio);
  const textHeight = lines.length * lineHeight;
  const prefix = markers?.inline ? markers.width + markers.gap : 0;
  const todoSpace = details?.todo !== undefined ? DETAIL_CONTROL_SPACE : 0;
  const entrySpace = details?.entry ? DETAIL_CONTROL_SPACE : 0;
  const textHeaderHeight = markers ? markers.inline ? Math.max(textHeight, markers.height) : markers.height + markers.gap + textHeight : textHeight;
  const headerHeight = Math.max(textHeaderHeight, todoSpace || entrySpace ? DETAIL_CONTROL_SIZE : 0);
  const showImage = image !== null && image.src !== '';
  const detailsHeight = details?.height ?? 0;
  const contentHeight = headerHeight + (showImage ? NODE_METRICS.imageGap + image.height : 0) + detailsHeight;
  const top = box.y + (box.height - contentHeight) / 2;
  const alignX = (width: number) => style.textAlign === 'left' ? box.x + NODE_METRICS.paddingX
    : style.textAlign === 'right' ? box.x + box.width - NODE_METRICS.paddingX - width : box.x + (box.width - width) / 2;
  const rowWidth = details?.rowWidth || markers?.rowWidth || box.width - NODE_METRICS.paddingX * 2;
  const rowX = alignX(rowWidth);
  const textRect = {
    x: rowX + todoSpace + prefix,
    y: top + (markers && !markers.inline ? markers.height + markers.gap : (headerHeight - textHeight) / 2),
    width: rowWidth - todoSpace - entrySpace - prefix,
    height: textHeight,
  };
  const textAnchor = style.textAlign === 'left' ? 'start' as const : style.textAlign === 'right' ? 'end' as const : 'middle' as const;
  const textX = textRect.x + (style.textAlign === 'left' ? 0 : style.textAlign === 'right' ? textRect.width : textRect.width / 2);
  const markerX = markers ? markers.inline ? rowX + todoSpace : rowX + todoSpace + (rowWidth - todoSpace - entrySpace - markers.width) / 2 : 0;
  const markerY = top + (markers?.inline ? (headerHeight - markers.height) / 2 : 0);
  const controlY = textRect.y + (textHeight - DETAIL_CONTROL_SIZE) / 2;
  return { detailsY: top + contentHeight - detailsHeight, textRect, textX, textAnchor, firstY: textRect.y + lineHeight / 2,
    todoRect: todoSpace ? { x: rowX, y: controlY, width: DETAIL_CONTROL_SIZE, height: DETAIL_CONTROL_SIZE } : undefined,
    entryRect: entrySpace ? { x: rowX + rowWidth - DETAIL_CONTROL_SIZE, y: controlY, width: DETAIL_CONTROL_SIZE, height: DETAIL_CONTROL_SIZE } : undefined,
    imageX: box.x + (box.width - (image?.width ?? 0)) / 2, imageY: top + headerHeight + NODE_METRICS.imageGap,
    markerRects: markers?.items.map((marker, index) => ({ marker,
      x: markerX + index % markers.columns * (markers.size + markers.gap),
      y: markerY + Math.floor(index / markers.columns) * (markers.size + markers.gap), size: markers.size })) ?? [],
  };
}
