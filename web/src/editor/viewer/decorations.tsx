/**
 * 关系线、边界、概要的渲染。
 *
 * 这三者都是「画在主题之间」的附属结构，与父子连线分属不同图层：
 *
 * - 边界要在连线**下面**（它是一块背景区域）；
 * - 关系线在连线**上面**（否则会被密集的分支线盖住）；
 * - 概要按分支方向向外避让，跟主题同一层，但要画在主题**之前**——
 *   括号的横臂会伸进节点之间。
 *
 * 几何全部来自 `layout/annotations.ts`，这里只把坐标画出来：不测量、不算并集、
 * 不猜样式。导出与缩略图走的是同一份 `AnnotationLayout`，所以「导出的图与
 * 画布所见一致」不是靠两边写得像，而是同一组数字。
 */

import type { AnnotationLayout, SummaryAnnotation } from '../layout/annotations';
import type { LineEnd } from '../model/types';
import { topicElementId } from './a11y-ids';
import type { Point } from '../layout/types';

/** 选中态的高亮色。用 `currentColor` 拿不到主题变量，这里取一个中性蓝。 */
const SELECTED = '#2563EB';

export function BoundariesLayer({
  annotations,
  selectedId = null,
  interactive = false,
  interactiveLabel = "Boundary",
}: {
  annotations: AnnotationLayout;
  selectedId?: string | null;
  interactive?: boolean;
  interactiveLabel?: string;
}) {
  return (
    <g className="layer-boundaries">
      {annotations.boundaries.map((boundary) => {
        const selected = selectedId === boundary.id;
        return (
          <g key={boundary.id} data-boundary-id={boundary.id}
            role={interactive ? 'button' : undefined} tabIndex={interactive ? 0 : undefined}
            aria-label={interactive ? boundary.title || interactiveLabel : undefined}
            aria-pressed={interactive ? selected : undefined}
            className={interactive ? 'cursor-pointer outline-none focus-visible:opacity-70' : undefined}>
            <rect
              x={boundary.rect.x}
              y={boundary.rect.y}
              width={boundary.rect.width}
              height={boundary.rect.height}
              rx={10}
              pointerEvents="none"
              fill={boundary.fill}
              fillOpacity={boundary.fillOpacity}
              stroke={selected ? SELECTED : boundary.stroke}
              strokeWidth={selected ? boundary.strokeWidth + 1 : boundary.strokeWidth}
              strokeDasharray={boundary.strokeDasharray}
            />
            {interactive ? <rect data-boundary-hit="" {...boundary.rect} rx={10} fill="none" stroke="transparent"
              strokeWidth={14} vectorEffect="non-scaling-stroke" pointerEvents="stroke" /> : null}
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
  interactive = false,
  interactiveLabel = 'Relationship',
}: {
  annotations: AnnotationLayout;
  selectedId?: string | null;
  interactive?: boolean;
  interactiveLabel?: string;
}) {
  return (
    <g className="layer-relationships">
      {annotations.relationships.map((relationship) => {
        const selected = selectedId === relationship.id;
        const color = relationship.color;
        return (
          <g
            key={relationship.id}
            data-relationship-id={relationship.id}
            role={interactive ? 'button' : undefined}
            tabIndex={interactive ? 0 : undefined}
            aria-label={interactive ? relationship.title || interactiveLabel : undefined}
            aria-pressed={interactive ? selected : undefined}
            className={interactive ? 'cursor-pointer outline-none focus-visible:opacity-70' : undefined}
          >
            {interactive ? (
              <path data-relationship-hit="" d={relationship.path} fill="none" stroke="transparent"
                strokeWidth={Math.max(14, relationship.width + 8)} vectorEffect="non-scaling-stroke" pointerEvents="stroke" />
            ) : null}
            {selected ? <path d={relationship.path} fill="none" stroke={SELECTED} strokeWidth={relationship.width + 6} opacity={0.22} pointerEvents="none" /> : null}
            <path
              data-relationship-path=""
              d={relationship.path}
              fill="none"
              stroke={color}
              strokeWidth={relationship.width}
              strokeDasharray={relationship.dash}
            />
            <RelationshipEnd kind={relationship.lineStart} point={relationship.from} angle={relationship.startAngle} color={color} width={relationship.width} end="start" />
            <RelationshipEnd kind={relationship.lineEnd} point={relationship.to} angle={relationship.endAngle} color={color} width={relationship.width} end="end" />
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

function RelationshipEnd({ kind, point, angle, color, width, end }: {
  kind: LineEnd; point: Point; angle: number; color: string; width: number; end: 'start' | 'end';
}) {
  if (kind === 'none') return null;
  if (kind === 'dot') return <circle data-relationship-end={end} cx={point.x} cy={point.y} r={Math.max(2, width * 1.4)} fill={color} />;
  const size = Math.max(7, width * 3);
  return <polygon data-relationship-end={end} points={`0,0 ${-size},${-size / 2} ${-size},${size / 2}`}
    transform={`translate(${point.x} ${point.y}) rotate(${angle})`} fill={color} />;
}

export function SummariesLayer({
  annotations,
  selectedId = null,
  selection = new Set<string>(),
  interactive = false,
  interactiveLabel = 'Summary',
}: {
  annotations: AnnotationLayout;
  selectedId?: string | null;
  selection?: ReadonlySet<string>;
  interactive?: boolean;
  interactiveLabel?: string;
}) {
  return (
    <g className="layer-summaries">
      {annotations.summaries.map((summary: SummaryAnnotation) => {
        const selected = selectedId === summary.id || selection.has(summary.id);
        const stroke = selected ? SELECTED : summary.style.borderColor;
        return (
          <g key={summary.id} data-summary-id={summary.id} id={interactive ? topicElementId(summary.id) : undefined}
            role={interactive ? "treeitem" : undefined} aria-level={interactive ? 1 : undefined}
            aria-selected={interactive ? selected : undefined} aria-label={interactive ? summary.title || interactiveLabel : undefined}
            className={interactive ? "cursor-pointer" : undefined}>
            {/* 独立圆弧括号与节点留白，只在中点连接概要文字。 */}
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
