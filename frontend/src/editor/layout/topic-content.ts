import type { ComputedStyle } from '../model/types';
import type { ImageSize, MarkerLayout, NodeBox } from './types';
import { NODE_METRICS } from './constants';

/** 测量之后的内容定位，渲染和 HTML 编辑框共同读取。 */
export function topicContentGeometry(box: NodeBox, style: ComputedStyle, lines: readonly string[], image: ImageSize | null, markers?: MarkerLayout, detailsHeight = 0) {
  const lineHeight = Math.round(style.fontSize * NODE_METRICS.lineHeightRatio);
  const textHeight = lines.length * lineHeight;
  const prefix = markers?.inline ? markers.width + markers.gap : 0;
  const headerHeight = markers ? markers.inline ? Math.max(textHeight, markers.height) : markers.height + markers.gap + textHeight : textHeight;
  const showImage = image !== null && image.src !== '';
  const contentHeight = headerHeight + (showImage ? NODE_METRICS.imageGap + image.height : 0) + detailsHeight;
  const top = box.y + (box.height - contentHeight) / 2;
  const alignX = (width: number) => style.textAlign === 'left' ? box.x + NODE_METRICS.paddingX
    : style.textAlign === 'right' ? box.x + box.width - NODE_METRICS.paddingX - width : box.x + (box.width - width) / 2;
  const rowWidth = markers?.rowWidth ?? box.width - NODE_METRICS.paddingX * 2;
  const textRect = {
    x: alignX(rowWidth) + prefix,
    y: top + (markers && !markers.inline ? markers.height + markers.gap : (headerHeight - textHeight) / 2),
    width: rowWidth - prefix,
    height: textHeight,
  };
  const textAnchor = style.textAlign === 'left' ? 'start' as const : style.textAlign === 'right' ? 'end' as const : 'middle' as const;
  const textX = textRect.x + (style.textAlign === 'left' ? 0 : style.textAlign === 'right' ? textRect.width : textRect.width / 2);
  const markerX = markers ? markers.inline ? alignX(rowWidth) : alignX(markers.width) : 0;
  const markerY = top + (markers?.inline ? (headerHeight - markers.height) / 2 : 0);
  return { detailsY: top + contentHeight - detailsHeight, textRect, textX, textAnchor, firstY: textRect.y + lineHeight / 2,
    imageX: box.x + (box.width - (image?.width ?? 0)) / 2, imageY: top + headerHeight + NODE_METRICS.imageGap,
    markerRects: markers?.items.map((marker, index) => ({ marker,
      x: markerX + index % markers.columns * (markers.size + markers.gap),
      y: markerY + Math.floor(index / markers.columns) * (markers.size + markers.gap), size: markers.size })) ?? [],
  };
}
