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

/** 括号连线：横向伸出的长度与拐角半径。两个常量放在这里，渲染层自洽。 */
const BRACE_TRUNK = 14;
const BRACE_RADIUS = 8;

/**
 * 连线路径。
 *
 * 控制点/折点放在**走向**的中点：横向树里连线从节点侧面伸出，两端切线水平，
 * 所以控制点在 x 的中点；纵向树（org-chart）从下沿伸出，切线垂直，控制点在
 * y 的中点。用 `from.y === to.y` 之类的几何猜测在斜边上会猜错，所以走向由
 * 布局层显式给出（`edge.orientation`）。
 */
export function edgePath(edge: EdgePath): string {
  const { from, to, orientation } = edge;

  switch (edge.lineStyle) {
    case 'none':
      return '';
    case 'straight':
      return `M ${from.x} ${from.y} L ${to.x} ${to.y}`;
    case 'elbow':
      if (orientation === 'v') {
        const midY = (from.y + to.y) / 2;
        return `M ${from.x} ${from.y} V ${midY} H ${to.x} V ${to.y}`;
      }
      return `M ${from.x} ${from.y} H ${(from.x + to.x) / 2} V ${to.y} H ${to.x}`;
    case 'axis':
      // 时间轴：先沿主轴横走，再竖着落到节点上。多个子节点的横段叠起来
      // 就是那条主轴，竖段就是每个节点的刻度。
      if (orientation === 'v') return `M ${from.x} ${from.y} V ${to.y} H ${to.x}`;
      return `M ${from.x} ${from.y} H ${to.x} V ${to.y}`;
    case 'brace': {
      // 括号：父节点先横出一小段，再在**同一个 x** 上竖直走，最后拐进子节点。
      // 同一个父节点的所有子连线共用这个 x，合起来就是「}」。
      const trunk = from.x + BRACE_TRUNK * (to.x >= from.x ? 1 : -1);
      const r = Math.min(BRACE_RADIUS, Math.abs(to.y - from.y) / 2, Math.abs(to.x - from.x) / 2);
      const up = to.y < from.y ? -1 : 1;
      return [
        `M ${from.x} ${from.y}`,
        `H ${trunk - r * (to.x >= from.x ? 1 : -1)}`,
        `Q ${trunk} ${from.y} ${trunk} ${from.y + r * up}`,
        `V ${to.y - r * up}`,
        `Q ${trunk} ${to.y} ${trunk + r * (to.x >= from.x ? 1 : -1)} ${to.y}`,
        `H ${to.x}`,
      ].join(' ');
    }
    case 'curve':
    default:
      if (orientation === 'v') {
        const midY = (from.y + to.y) / 2;
        return `M ${from.x} ${from.y} C ${from.x} ${midY} ${to.x} ${midY} ${to.x} ${to.y}`;
      }
      return `M ${from.x} ${from.y} C ${(from.x + to.x) / 2} ${from.y} ${(from.x + to.x) / 2} ${to.y} ${to.x} ${to.y}`;
  }
}

interface EndProps {
  edge: EdgePath;
}

function LineEnd({ edge }: EndProps) {
  if (edge.lineEnd === 'none') return null;
  const { to } = edge;
  // 方向由走向决定：纵向树向下生长，横向树向右或向左。
  const direction = edge.orientation === 'v'
    ? (to.y >= edge.from.y ? 1 : -1)
    : (to.x >= edge.from.x ? 1 : -1);

  if (edge.lineEnd === 'dot') {
    return <circle cx={to.x} cy={to.y} r={Math.max(2, edge.lineWidth * 1.4)} fill={edge.lineColor} />;
  }

  const size = Math.max(6, edge.lineWidth * 3);
  const half = size / 2;
  // 纵向的箭头沿 y 轴，横向的沿 x 轴——旋转 90° 而不是另画一套坐标。
  const points = edge.orientation === 'v'
    ? [
        [to.x, to.y],
        [to.x - half, to.y - direction * size],
        [to.x + half, to.y - direction * size],
      ]
    : [
        [to.x, to.y],
        [to.x - direction * size, to.y - half],
        [to.x - direction * size, to.y + half],
      ];

  return <polygon points={points.map((p) => p.join(',')).join(' ')} fill={edge.lineColor} />;
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
