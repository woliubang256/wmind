/**
 * 关系线、边界、汇总的渲染。
 *
 * 这三者都是「画在节点之间」的附属结构，与父子连线分属不同图层：
 * 边界要在连线**下面**，关系线在连线**上面**（否则会被密集的分支线盖住），
 * 所以它们各自是独立的 `<g>`，而不是塞进 edges 层。
 */

import type { Boundary, Relationship, Sheet, Theme } from '../model/types';
import type { LayoutResult, NodeBox } from '../layout/types';
import { dashArray } from './shapes';

/** 一组节点的包围盒，外扩 `pad`。 */
function unionOf(boxes: NodeBox[], pad: number) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const box of boxes) {
    if (box.x < minX) minX = box.x;
    if (box.y < minY) minY = box.y;
    if (box.x + box.width > maxX) maxX = box.x + box.width;
    if (box.y + box.height > maxY) maxY = box.y + box.height;
  }
  if (!Number.isFinite(minX)) return null;
  return { x: minX - pad, y: minY - pad, width: maxX - minX + pad * 2, height: maxY - minY + pad * 2 };
}

export function BoundariesLayer({ sheet, layout, theme }: { sheet: Sheet; layout: LayoutResult; theme: Theme }) {
  return (
    <g className="layer-boundaries">
      {sheet.boundaries.map((boundary: Boundary) => {
        const boxes = boundary.range
          .map((id) => layout.boxes.get(id))
          .filter((box): box is NodeBox => box !== undefined);
        const rect = unionOf(boxes, 16);
        if (!rect) return null;

        const style = { ...theme.boundary, ...boundary.style };
        const stroke = style.borderColor ?? '#999999';
        const width = style.borderWidth ?? 1.5;
        return (
          <g key={boundary.id} data-boundary-id={boundary.id}>
            <rect
              x={rect.x}
              y={rect.y}
              width={rect.width}
              height={rect.height}
              rx={10}
              fill={style.fill ?? 'none'}
              fillOpacity={0.5}
              stroke={stroke}
              strokeWidth={width}
              strokeDasharray={dashArray(style.borderStyle ?? 'dash', width)}
            />
            {boundary.title ? (
              <text
                x={rect.x + 8}
                y={rect.y - 4}
                // 白色描边做衬底：边界标题经常压在虚线上，没有衬底会糊成一片。
                stroke="#FFFFFF"
                strokeWidth={3}
                strokeLinejoin="round"
                paintOrder="stroke"
                style={{ fontSize: 12, fill: stroke, fontWeight: 600 }}
              >
                {boundary.title}
              </text>
            ) : null}
          </g>
        );
      })}
    </g>
  );
}

export function RelationshipsLayer({ sheet, layout, theme }: { sheet: Sheet; layout: LayoutResult; theme: Theme }) {
  return (
    <g className="layer-relationships">
      {sheet.relationships.map((relationship: Relationship) => {
        const from = layout.boxes.get(relationship.end1Id);
        const to = layout.boxes.get(relationship.end2Id);
        if (!from || !to) return null;

        const style = { ...theme.relationship, ...relationship.style };
        const color = style.lineColor ?? '#999999';
        const width = style.lineWidth ?? 1;

        const x1 = from.x + from.width / 2;
        const y1 = from.y + from.height / 2;
        const x2 = to.x + to.width / 2;
        const y2 = to.y + to.height / 2;

        // 控制点从弦的中点沿法线外推，画出一段真正的弧。
        //
        // 直接用中点当控制点的话，二次贝塞尔退化成直线——两个节点横向相邻时，
        // 直线正好穿过它们中间的那个节点，标题也跟着被压在节点下面看不见。
        // 外推的幅度取弦长的四分之一并封顶 60px：太大会绕出画布，太小还是会
        // 被节点盖住。
        const dx = x2 - x1;
        const dy = y2 - y1;
        const length = Math.hypot(dx, dy) || 1;
        const bulge = Math.min(60, length * 0.25);
        const controlX = (x1 + x2) / 2 - (dy / length) * bulge;
        const controlY = (y1 + y2) / 2 + (dx / length) * bulge;

        // 二次贝塞尔在 t = 0.5 处的点，标题放在这里而不是弦的中点。
        const labelX = (x1 + 2 * controlX + x2) / 4;
        const labelY = (y1 + 2 * controlY + y2) / 4;

        return (
          <g key={relationship.id} data-relationship-id={relationship.id}>
            <path
              d={`M ${x1} ${y1} Q ${controlX} ${controlY} ${x2} ${y2}`}
              fill="none"
              stroke={color}
              strokeWidth={width}
              strokeDasharray="5 4"
            />
            {relationship.title ? (
              <text
                x={labelX}
                y={labelY - 6}
                textAnchor="middle"
                stroke="#FFFFFF"
                strokeWidth={3}
                strokeLinejoin="round"
                paintOrder="stroke"
                style={{ fontSize: 12, fill: color }}
              >
                {relationship.title}
              </text>
            ) : null}
          </g>
        );
      })}
    </g>
  );
}
