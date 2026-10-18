/**
 * 父子连线。
 *
 * 端点已经在布局层算在节点边缘上，这里只负责把两点连成一条路径。
 * 端点装饰（箭头 / 圆点）用**显式图形**画，不用 SVG `<marker>`：
 * `<marker>` 默认不继承 `stroke`，要靠 `context-stroke` 才能跟随线条颜色，
 * 而 Safari 对 `context-stroke` 的支持一直不稳。显式画一个三角形只多几行代码，
 * 但颜色、大小、方向都完全可控。
 */

import type { EdgePath } from '../layout/types';

/** 三次贝塞尔的控制点放在水平中点：两端切线水平，连线从节点侧面平滑伸出。 */
export function edgePath(edge: EdgePath): string {
  const { from, to } = edge;
  const midX = (from.x + to.x) / 2;

  switch (edge.lineStyle) {
    case 'none':
      return '';
    case 'straight':
      return `M ${from.x} ${from.y} L ${to.x} ${to.y}`;
    case 'elbow':
      return `M ${from.x} ${from.y} H ${midX} V ${to.y} H ${to.x}`;
    case 'curve':
    default:
      return `M ${from.x} ${from.y} C ${midX} ${from.y} ${midX} ${to.y} ${to.x} ${to.y}`;
  }
}

interface EndProps {
  edge: EdgePath;
}

function LineEnd({ edge }: EndProps) {
  if (edge.lineEnd === 'none') return null;
  const { to } = edge;
  // 方向由「父在左还是在右」决定：右侧分支向右生长，左侧向左。
  const direction = to.x >= edge.from.x ? 1 : -1;

  if (edge.lineEnd === 'dot') {
    return <circle cx={to.x} cy={to.y} r={Math.max(2, edge.lineWidth * 1.4)} fill={edge.lineColor} />;
  }

  const size = Math.max(6, edge.lineWidth * 3);
  const half = size / 2;
  return (
    <polygon
      points={[
        [to.x, to.y],
        [to.x - direction * size, to.y - half],
        [to.x - direction * size, to.y + half],
      ].map((p) => p.join(',')).join(' ')}
      fill={edge.lineColor}
    />
  );
}

export function EdgeLine({ edge }: { edge: EdgePath }) {
  if (edge.lineStyle === 'none') return null;
  return (
    <g data-edge-id={edge.id}>
      <path
        d={edgePath(edge)}
        fill="none"
        stroke={edge.lineColor}
        strokeWidth={edge.lineWidth}
        strokeLinecap="round"
      />
      <LineEnd edge={edge} />
    </g>
  );
}
