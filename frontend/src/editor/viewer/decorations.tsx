/**
 * 关系线、边界、概要的渲染。
 *
 * 这三者都是「画在主题之间」的附属结构，与父子连线分属不同图层：
 *
 * - 边界要在连线**下面**（它是一块背景区域）；
 * - 关系线在连线**上面**（否则会被密集的分支线盖住）；
 * - 概要贴着被概要范围的右缘，跟主题同一层，但要画在主题**之前**——
 *   概要节点永远在范围右侧，不重叠，但括号的横臂会伸进节点之间。
 *
 * 几何全部来自 `layout/annotations.ts`，这里只把坐标画出来：不测量、不算并集、
 * 不猜样式。导出与缩略图走的是同一份 `AnnotationLayout`，所以「导出的图与
 * 画布所见一致」不是靠两边写得像，而是同一组数字。
 */

import type { AnnotationLayout, SummaryAnnotation } from '../layout/annotations';

/** 选中态的高亮色。用 `currentColor` 拿不到主题变量，这里取一个中性蓝。 */
const SELECTED = '#2563EB';

export function BoundariesLayer({
  annotations,
  selectedId = null,
}: {
  annotations: AnnotationLayout;
  selectedId?: string | null;
}) {
  return (
    <g className="layer-boundaries">
      {annotations.boundaries.map((boundary) => {
        const selected = selectedId === boundary.id;
        return (
          <g key={boundary.id} data-boundary-id={boundary.id}>
            <rect
              x={boundary.rect.x}
              y={boundary.rect.y}
              width={boundary.rect.width}
              height={boundary.rect.height}
              rx={10}
              fill={boundary.fill}
              fillOpacity={boundary.fillOpacity}
              stroke={selected ? SELECTED : boundary.stroke}
              strokeWidth={selected ? boundary.strokeWidth + 1 : boundary.strokeWidth}
              strokeDasharray={boundary.strokeDasharray}
            />
            {boundary.title ? (
              <text
                x={boundary.rect.x + 8}
                y={boundary.rect.y - 4}
                // 白色描边做衬底：边界标题经常压在虚线上，没有衬底会糊成一片。
                stroke="#FFFFFF"
                strokeWidth={3}
                strokeLinejoin="round"
                paintOrder="stroke"
                style={{ fontSize: 12, fill: selected ? SELECTED : boundary.stroke, fontWeight: 600 }}
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

export function RelationshipsLayer({
  annotations,
  selectedId = null,
}: {
  annotations: AnnotationLayout;
  selectedId?: string | null;
}) {
  return (
    <g className="layer-relationships">
      {annotations.relationships.map((relationship) => {
        const selected = selectedId === relationship.id;
        const color = selected ? SELECTED : relationship.color;
        return (
          <g key={relationship.id} data-relationship-id={relationship.id}>
            <path
              d={`M ${relationship.from.x} ${relationship.from.y} Q ${relationship.control.x} ${relationship.control.y} ${relationship.to.x} ${relationship.to.y}`}
              fill="none"
              stroke={color}
              strokeWidth={selected ? relationship.width + 1 : relationship.width}
              strokeDasharray={relationship.dash}
            />
            {relationship.title ? (
              <text
                x={relationship.label.x}
                y={relationship.label.y - 6}
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

export function SummariesLayer({
  annotations,
  selectedId = null,
}: {
  annotations: AnnotationLayout;
  selectedId?: string | null;
}) {
  return (
    <g className="layer-summaries">
      {annotations.summaries.map((summary: SummaryAnnotation) => {
        const selected = selectedId === summary.id;
        const stroke = selected ? SELECTED : summary.style.borderColor;
        return (
          <g key={summary.id} data-summary-id={summary.id}>
            {/* 括号：从被概要范围的右缘上下两端收进来，再连到概要节点。 */}
            <path
              d={summary.brace}
              fill="none"
              stroke={stroke}
              strokeWidth={summary.style.borderWidth}
              strokeLinecap="round"
            />
            <line
              x1={summary.connector.from.x}
              y1={summary.connector.from.y}
              x2={summary.connector.to.x}
              y2={summary.connector.to.y}
              stroke={stroke}
              strokeWidth={summary.style.borderWidth}
            />
            <rect
              x={summary.rect.x}
              y={summary.rect.y}
              width={summary.rect.width}
              height={summary.rect.height}
              rx={8}
              fill={summary.style.fill}
              stroke={stroke}
              strokeWidth={summary.style.borderWidth}
            />
            {summary.lines.map((line, index) => (
              <text
                key={`${summary.id}-${index}`}
                x={summary.rect.x + summary.rect.width / 2}
                y={
                  // 文本块整体竖直居中：第一行基线 = 中心 - 总高/2 + 行高。
                  summary.rect.y +
                  summary.rect.height / 2 -
                  (summary.lines.length * summary.style.fontSize * 1.4) / 2 +
                  summary.style.fontSize * 1.4 * (index + 0.8)
                }
                textAnchor="middle"
                style={{
                  fontSize: summary.style.fontSize,
                  fontWeight: summary.style.fontWeight,
                  fill: selected ? SELECTED : summary.style.textColor,
                }}
              >
                {line}
              </text>
            ))}
          </g>
        );
      })}
    </g>
  );
}

/** 边界虚线：`borderStyle` 是文档里的枚举，换算成 SVG 的 `stroke-dasharray` 在
 * `layout/annotations.ts` 里做，渲染层只负责把字符串贴上去。 */
