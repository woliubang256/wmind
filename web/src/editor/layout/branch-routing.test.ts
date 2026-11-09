import { describe, expect, it } from 'vitest';
import { fanCurveControls, topicOutlinePoint } from './branch-routing';

const box = { x: 10, y: 20, width: 100, height: 40 };

describe('真实主题轮廓端点', () => {
  it.each(['rect', 'rounded-rect', 'capsule', 'ellipse', 'diamond', 'hexagon', 'none'] as const)('%s 水平接在左右边缘', (shape) => {
    expect(topicOutlinePoint(box, shape, { x: 1, y: 0 })).toEqual({ x: 110, y: 40 });
    expect(topicOutlinePoint(box, shape, { x: -1, y: 0 })).toEqual({ x: 10, y: 40 });
  });
  it('椭圆与圆形的斜向端点位于实际弧线上，圆形不使用较宽的包围盒', () => {
    const ellipse = topicOutlinePoint(box, 'ellipse', { x: 1, y: -2 });
    expect(((ellipse.x - 60) / 50) ** 2 + ((ellipse.y - 40) / 20) ** 2).toBeCloseTo(1, 8);
    const circle = topicOutlinePoint(box, 'circle', { x: 1, y: -2 });
    expect(Math.hypot(circle.x - 60, circle.y - 40)).toBeCloseTo(20, 8);
    expect(topicOutlinePoint(box, 'circle', { x: 1, y: 0 })).toEqual({ x: 80, y: 40 });
  });
  it('圆角矩形与胶囊的斜向端点落在圆角上', () => {
    const rounded = topicOutlinePoint(box, 'rounded-rect', { x: 2.5, y: 1 });
    expect(Math.hypot(rounded.x - 100, rounded.y - 50)).toBeCloseTo(10, 8);
    const capsule = topicOutlinePoint(box, 'capsule', { x: 2.5, y: 1 });
    expect(Math.hypot(capsule.x - 90, capsule.y - 40)).toBeCloseTo(20, 8);
  });
  it('菱形、六边形和平行四边形使用斜边，不把包围盒当轮廓', () => {
    const diamond = topicOutlinePoint(box, 'diamond', { x: 1, y: 1 });
    expect(Math.abs(diamond.x - 60) / 50 + Math.abs(diamond.y - 40) / 20).toBeCloseTo(1, 8);
    const hexagon = topicOutlinePoint(box, 'hexagon', { x: 2, y: 1 });
    expect(hexagon.x + hexagon.y).toBeCloseTo(150, 8);
    const parallelogram = topicOutlinePoint(box, 'parallelogram', { x: 1, y: 0 });
    expect(parallelogram.x).toBeCloseTo(110 - 40 / 6, 8);
    expect(parallelogram.y).toBe(40);
  });
  it('仅下划线连接实际线段端点', () => {
    expect(topicOutlinePoint(box, 'underline', { x: -1, y: 0 })).toEqual({ x: 10, y: 60 });
    expect(topicOutlinePoint(box, 'underline', { x: 1, y: 0 })).toEqual({ x: 110, y: 60 });
  });
});

describe('扇形曲线控制点', () => {
  it.each([-1, 1])('左右镜像 %s：控制点在端点包围盒内，末端水平', (side) => {
    for (const y of [-500, -10, 0, 10, 500]) {
      const from = { x: 0, y: 0 };
      const to = { x: 150 * side, y };
      const points = fanCurveControls(from, to, { x: side * 0.4, y: Math.sign(y) * 0.9 });
      for (const point of points) {
        expect(Number.isFinite(point.x) && Number.isFinite(point.y)).toBe(true);
        expect(point.x).toBeGreaterThanOrEqual(Math.min(from.x, to.x));
        expect(point.x).toBeLessThanOrEqual(Math.max(from.x, to.x));
        expect(point.y).toBeGreaterThanOrEqual(Math.min(from.y, to.y));
        expect(point.y).toBeLessThanOrEqual(Math.max(from.y, to.y));
      }
      expect(points[1].y).toBe(to.y);
    }
  });
});
