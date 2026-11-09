import type { ShapeClass } from '../model/types';
import type { Point, Rect } from './types';

const cross = (a: Point, b: Point) => a.x * b.y - a.y * b.x;

/** 与 TopicShape 的实际轮廓相交；direction 是从中心向外的射线。 */
export function topicOutlinePoint(box: Rect, shape: ShapeClass, direction: Point): Point {
  const a = box.width / 2;
  const b = box.height / 2;
  const cx = box.x + a;
  const cy = box.y + b;
  const length = Math.hypot(direction.x, direction.y);
  const d = length > 0 ? { x: direction.x / length, y: direction.y / length } : { x: 1, y: 0 };
  const point = (t: number) => ({ x: cx + d.x * t, y: cy + d.y * t });

  if (shape === 'underline') return { x: cx + (d.x < 0 ? -a : a), y: box.y + box.height };
  if (shape === 'circle') return point(Math.min(a, b));
  if (shape === 'ellipse') return point(1 / Math.hypot(d.x / a, d.y / b));
  if (shape === 'diamond') return point(1 / (Math.abs(d.x) / a + Math.abs(d.y) / b));

  if (shape === 'hexagon' || shape === 'parallelogram') {
    // 与 shapes.tsx 共用相同的 SVG 顶点定义，顶点相对于盒子中心。
    const inset = shape === 'hexagon' ? Math.min(b, box.width / 3) : Math.min(box.height / 3, box.width / 4);
    const vertices = shape === 'hexagon'
      ? [{ x: -a + inset, y: -b }, { x: a - inset, y: -b }, { x: a, y: 0 },
        { x: a - inset, y: b }, { x: -a + inset, y: b }, { x: -a, y: 0 }]
      : [{ x: -a + inset, y: -b }, { x: a, y: -b }, { x: a - inset, y: b }, { x: -a, y: b }];
    let nearest = Infinity;
    for (let i = 0; i < vertices.length; i += 1) {
      const start = vertices[i]!;
      const end = vertices[(i + 1) % vertices.length]!;
      const edge = { x: end.x - start.x, y: end.y - start.y };
      const denominator = cross(d, edge);
      if (Math.abs(denominator) < 1e-9) continue;
      const t = cross(start, edge) / denominator;
      const u = cross(start, d) / denominator;
      if (t >= 0 && u >= -1e-9 && u <= 1 + 1e-9) nearest = Math.min(nearest, t);
    }
    return point(Number.isFinite(nearest) ? nearest : 0);
  }

  const t = Math.min(Math.abs(d.x) > 1e-9 ? a / Math.abs(d.x) : Infinity,
    Math.abs(d.y) > 1e-9 ? b / Math.abs(d.y) : Infinity);
  const radius = shape === 'rounded-rect' ? Math.min(10, a, b)
    : shape === 'capsule' ? Math.min(a, b) : 0;
  if (radius === 0 || Math.abs(d.x * t) <= a - radius || Math.abs(d.y * t) <= b - radius) return point(t);
  // 矩形交点落在圆角区域，改求相应圆角圆弧的外侧交点。
  const projection = Math.abs(d.x) * (a - radius) + Math.abs(d.y) * (b - radius);
  const discriminant = projection ** 2 - ((a - radius) ** 2 + (b - radius) ** 2 - radius ** 2);
  return point(projection + Math.sqrt(Math.max(0, discriminant)));
}

/** 扇形曲线：从外缘朝分支方位展开，末端水平接入，控制点不越过端点包围盒。 */
export function fanCurveControls(from: Point, to: Point, direction: Point): [Point, Point] {
  const dx = Math.abs(to.x - from.x);
  const dy = to.y - from.y;
  const sign = to.x < from.x ? -1 : 1;
  const handle = Math.min(dx, Math.max(dx * 0.55, Math.abs(dy) * 0.22));
  return [
    { x: from.x + sign * Math.min(Math.abs(direction.x) * handle, dx * 0.55),
      y: from.y + Math.sign(dy) * Math.min(Math.abs(direction.y) * handle, Math.abs(dy) / 2) },
    { x: to.x - sign * dx * 0.4, y: to.y },
  ];
}
