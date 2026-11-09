/**
 * 形状渲染。
 *
 * 样式一律走**内联属性**而不是 CSS class（docs/05 §4.5）：SVG 序列化导出时
 * 样式自动携带，不需要额外注入 `<style>`；也不会因为 Tailwind 的类名裁剪
 * 把某个形状的样式裁掉。
 *
 * 形状几何全部用 path / 基础图元表达，不用 `<clipPath>` 或滤镜——后者在
 * 导出为图片时兼容性更差，且 Safari 对滤镜的边界处理有已知问题。
 */

import type { BorderStyle, ComputedStyle } from '../model/types';
import type { NodeBox } from '../layout/types';

export function dashArray(borderStyle: BorderStyle, borderWidth: number): string | undefined {
  if (borderStyle === 'dash') return `${borderWidth * 3} ${borderWidth * 2}`;
  if (borderStyle === 'dot') return `${borderWidth} ${borderWidth * 1.6}`;
  return undefined;
}

interface Paint {
  fill: string;
  stroke: string;
  strokeWidth: number;
  strokeDasharray?: string;
  strokeLinejoin: 'round';
}

export function paintOf(style: ComputedStyle): Paint {
  return {
    // fillPattern 为 none 时不填充；gradient 暂时按纯色处理（M3 再上 <linearGradient>）。
    fill: style.fillPattern === 'none' ? 'none' : (style.fill ?? 'none'),
    stroke: style.borderStyle === 'none' || style.borderWidth <= 0 ? 'none' : style.borderColor,
    strokeWidth: style.borderWidth,
    strokeDasharray: dashArray(style.borderStyle, style.borderWidth),
    strokeLinejoin: 'round',
  };
}

/** 六边形：左右各缩进半个高度。 */
function hexPoints(box: NodeBox): string {
  const inset = Math.min(box.height / 2, box.width / 3);
  const { x, y, width: w, height: h } = box;
  return [
    [x + inset, y],
    [x + w - inset, y],
    [x + w, y + h / 2],
    [x + w - inset, y + h],
    [x + inset, y + h],
    [x, y + h / 2],
  ].map((p) => p.join(',')).join(' ');
}

/** 平行四边形：上下边各偏移高度的 1/3。 */
function parallelogramPoints(box: NodeBox): string {
  const skew = Math.min(box.height / 3, box.width / 4);
  const { x, y, width: w, height: h } = box;
  return [
    [x + skew, y],
    [x + w, y],
    [x + w - skew, y + h],
    [x, y + h],
  ].map((p) => p.join(',')).join(' ');
}

function diamondPoints(box: NodeBox): string {
  const { x, y, width: w, height: h } = box;
  return [
    [x + w / 2, y],
    [x + w, y + h / 2],
    [x + w / 2, y + h],
    [x, y + h / 2],
  ].map((p) => p.join(',')).join(' ');
}

export function TopicShape({ box, style }: { box: NodeBox; style: ComputedStyle }) {
  const paint = paintOf(style);
  const { x, y, width: w, height: h } = box;

  switch (style.shape) {
    case 'none':
      return null;
    case 'underline':
      return (
        <line
          x1={x}
          y1={y + h}
          x2={x + w}
          y2={y + h}
          stroke={style.borderColor}
          strokeWidth={Math.max(style.borderWidth, 1)}
          strokeDasharray={paint.strokeDasharray}
        />
      );
    case 'rect':
      return <rect x={x} y={y} width={w} height={h} {...paint} />;
    case 'capsule':
      return <rect x={x} y={y} width={w} height={h} rx={h / 2} ry={h / 2} {...paint} />;
    case 'ellipse':
      return <ellipse cx={x + w / 2} cy={y + h / 2} rx={w / 2} ry={h / 2} {...paint} />;
    case 'circle': {
      const r = Math.min(w, h) / 2;
      return <circle cx={x + w / 2} cy={y + h / 2} r={r} {...paint} />;
    }
    case 'diamond':
      return <polygon points={diamondPoints(box)} {...paint} />;
    case 'hexagon':
      return <polygon points={hexPoints(box)} {...paint} />;
    case 'parallelogram':
      return <polygon points={parallelogramPoints(box)} {...paint} />;
    case 'rounded-rect':
    default:
      // 圆角不超过高度的一半，否则短节点会变成胶囊形（视觉上换了形状）。
      return <rect x={x} y={y} width={w} height={h} rx={Math.min(10, h / 2)} ry={Math.min(10, h / 2)} {...paint} />;
  }
}
