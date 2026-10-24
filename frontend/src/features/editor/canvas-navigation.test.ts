import { describe, expect, it } from 'vitest';
import { centeredViewport, scrollAxis } from './canvas-navigation';

describe('画布导航', () => {
  it('保持缩放并将中心主题几何中心定位到可视区域中心', () => {
    for (const zoom of [0.1, 0.75, 1, 2, 4]) {
      const root = { x: -125, y: 70, width: 150, height: 48 };
      const next = centeredViewport({ x: 1500, y: -700, zoom }, root, { width: 900, height: 600 });
      expect(next.zoom).toBe(zoom);
      expect(next.x + (root.x + root.width / 2) * zoom).toBe(450);
      expect(next.y + (root.y + root.height / 2) * zoom).toBe(300);
    }
  });
  it('小图、负坐标、大图及远距离平移时滚动位置可逆且滑块不越界', () => {
    for (const offset of [-10000, -100, 0, 500, 10000]) {
      for (const zoom of [0.1, 1, 4]) {
        for (const length of [100, 5000]) {
          const axis = scrollAxis(-300, length, 800, offset, zoom);
          expect(axis.fraction).toBeGreaterThanOrEqual(0);
          expect(axis.fraction).toBeLessThanOrEqual(1);
          expect(axis.visible).toBeGreaterThan(0);
          expect(axis.visible).toBeLessThan(1);
          expect(-(axis.min + axis.range * axis.fraction)).toBeCloseTo(offset);
        }
      }
    }
  });
});
