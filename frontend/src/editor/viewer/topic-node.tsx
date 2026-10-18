/**
 * 单个主题节点的渲染。
 *
 * `React.memo` + 自定义比较器是必需的：一张 1000 节点的导图每次按键都会重渲染
 * 整个 `<g>`，如果不做浅比较，React 会重建 1000 个节点的 vDOM 再 diff 一遍。
 * 比较器只比引用与原始值，不做深比较——`box` 与 `style` 都来自缓存，
 * 引用稳定是布局层与样式层共同保证的。
 */

import { memo } from 'react';
import type { ComputedStyle } from '../model/types';
import type { NodeBox } from '../layout/types';
import { NODE_METRICS } from '../layout/constants';
import { fontStack } from '../theme/fonts';
import { TopicShape } from './shapes';

export interface TopicNodeProps {
  box: NodeBox;
  style: ComputedStyle;
  lines: string[];
  selected: boolean;
  editing: boolean;
}

const SELECTION_INSET = 3;
const BADGE_RADIUS = 9;

export const TopicNode = memo(function TopicNode({
  box,
  style,
  lines,
  selected,
  editing,
}: TopicNodeProps) {
  const lineHeight = Math.round(style.fontSize * NODE_METRICS.lineHeightRatio);
  const centerY = box.y + box.height / 2;
  const firstY = centerY - ((lines.length - 1) * lineHeight) / 2;

  const anchor = style.textAlign === 'left' ? 'start' : style.textAlign === 'right' ? 'end' : 'middle';
  const textX = style.textAlign === 'left'
    ? box.x + NODE_METRICS.paddingX
    : style.textAlign === 'right'
      ? box.x + box.width - NODE_METRICS.paddingX
      : box.x + box.width / 2;

  // 折叠徽标放在「远离根」的一侧：左侧分支在左边缘，其余在右边缘。
  const badgeX = box.side === 'left' ? box.x : box.x + box.width;
  const showBadge = box.collapsed && box.hiddenChildren > 0;

  return (
    <g className="wmind-topic" data-topic-id={box.id} data-topic-side={box.side}>
      <TopicShape box={box} style={style} />

      <text
        x={textX}
        y={firstY}
        textAnchor={anchor}
        dominantBaseline="central"
        pointerEvents="none"
        style={{
          // 与 Canvas 测量用同一串字体栈，否则测出来的宽度与实际渲染对不上。
          fontFamily: fontStack(style.fontFamily),
          fontSize: style.fontSize,
          fontWeight: style.fontWeight,
          fontStyle: style.fontStyle,
          textDecoration: style.textDecoration,
          fill: style.textColor,
        }}
      >
        {lines.map((line, index) => (
          <tspan key={index} x={textX} y={firstY + index * lineHeight}>
            {line === '' ? '\u00a0' : line}
          </tspan>
        ))}
      </text>

      {showBadge ? (
        <g data-collapse-toggle={box.id} style={{ cursor: 'pointer' }}>
          <circle
            cx={badgeX}
            cy={centerY}
            r={BADGE_RADIUS}
            fill="var(--wmind-badge-bg, #FFFFFF)"
            stroke={style.lineColor}
            strokeWidth={1.5}
          />
          <text
            x={badgeX}
            y={centerY}
            textAnchor="middle"
            dominantBaseline="central"
            pointerEvents="none"
            style={{ fontSize: 10, fontWeight: 600, fill: style.lineColor }}
          >
            {box.hiddenChildren > 99 ? '99+' : box.hiddenChildren}
          </text>
        </g>
      ) : null}

      {/* 展开态且有子节点：悬停时浮现「折叠」按钮（减号）。
          折叠态那个带数字的徽标本身就是展开按钮，两者语义相同、位置相同。 */}
      {!box.collapsed && box.childCount > 0 ? (
        <g className="wmind-collapse-toggle" data-collapse-toggle={box.id} style={{ cursor: 'pointer' }}>
          <circle
            cx={badgeX}
            cy={centerY}
            r={BADGE_RADIUS}
            fill="var(--wmind-badge-bg, #FFFFFF)"
            stroke={style.lineColor}
            strokeWidth={1.5}
          />
          <path
            d={`M ${badgeX - 4} ${centerY} H ${badgeX + 4}`}
            stroke={style.lineColor}
            strokeWidth={1.5}
            strokeLinecap="round"
            pointerEvents="none"
          />
        </g>
      ) : null}

      {selected && !editing ? (
        <rect
          x={box.x - SELECTION_INSET}
          y={box.y - SELECTION_INSET}
          width={box.width + SELECTION_INSET * 2}
          height={box.height + SELECTION_INSET * 2}
          rx={Math.min(12, box.height / 2) + SELECTION_INSET}
          fill="none"
          stroke="var(--wmind-selection, #1E88E5)"
          strokeWidth={2}
          strokeDasharray="6 4"
          pointerEvents="none"
        />
      ) : null}
    </g>
  );
}, areEqual);

function areEqual(prev: TopicNodeProps, next: TopicNodeProps): boolean {
  return (
    prev.box === next.box &&
    prev.style === next.style &&
    prev.lines === next.lines &&
    prev.selected === next.selected &&
    prev.editing === next.editing
  );
}
