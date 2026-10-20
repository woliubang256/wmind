import { describe, expect, it } from 'vitest';
import {
  THUMBNAIL_MAX_HEIGHT,
  THUMBNAIL_MAX_WIDTH,
  THUMBNAIL_MIN_INTERVAL_MS,
  planThumbnail,
  shouldRefreshThumbnail,
} from './thumbnail-plan';

describe('planThumbnail', () => {
  it('宽图按宽度压到上限，高度同比缩小', () => {
    const plan = planThumbnail(3200, 1000);
    expect(plan.width).toBe(THUMBNAIL_MAX_WIDTH);
    expect(plan.height).toBe(200);
    expect(plan.scale).toBeCloseTo(0.2, 5);
  });

  it('高图按高度压到上限，宽度同比缩小', () => {
    const plan = planThumbnail(1000, 4000);
    expect(plan.height).toBe(THUMBNAIL_MAX_HEIGHT);
    expect(plan.width).toBe(100);
  });

  it('比上限小的图不放大', () => {
    const plan = planThumbnail(300, 200);
    expect(plan).toEqual({ scale: 1, width: 300, height: 200 });
  });

  it('极端长条不会算出 0 高', () => {
    // 4000×2 按比例算出来的高是 0.32px，四舍五入就是 0——canvas 拿到 0 就是空图。
    const plan = planThumbnail(4000, 2);
    expect(plan.height).toBe(1);
    expect(plan.width).toBe(THUMBNAIL_MAX_WIDTH);
  });

  it('尺寸算不出来时返回 0 尺寸，让调用方跳过', () => {
    for (const [width, height] of [
      [0, 100],
      [100, 0],
      [Number.NaN, 100],
      [100, Number.POSITIVE_INFINITY],
      [-5, 100],
    ]) {
      const plan = planThumbnail(width, height);
      expect(plan.width).toBe(0);
      expect(plan.height).toBe(0);
    }
  });

  it('正方形图受更紧的那一边约束', () => {
    const plan = planThumbnail(2000, 2000);
    expect(plan.height).toBe(THUMBNAIL_MAX_HEIGHT);
    expect(plan.width).toBe(THUMBNAIL_MAX_HEIGHT);
  });
});

describe('shouldRefreshThumbnail', () => {
  const now = 1_700_000_000_000;

  it('没有缩略图时一定生成', () => {
    expect(
      shouldRefreshThumbnail({ hasThumbnail: false, lastGeneratedAt: null, savedSinceGenerated: false, now }),
    ).toBe(true);
  });

  it('有缩略图但本会话没保存过时不生成', () => {
    // 打开看一眼就退出不该产生任何写入。
    expect(
      shouldRefreshThumbnail({ hasThumbnail: true, lastGeneratedAt: null, savedSinceGenerated: false, now }),
    ).toBe(false);
  });

  it('保存过、本会话还没生成时生成', () => {
    expect(
      shouldRefreshThumbnail({ hasThumbnail: true, lastGeneratedAt: null, savedSinceGenerated: true, now }),
    ).toBe(true);
  });

  it('间隔内不重复生成', () => {
    expect(
      shouldRefreshThumbnail({
        hasThumbnail: true,
        lastGeneratedAt: now - 1000,
        savedSinceGenerated: true,
        now,
      }),
    ).toBe(false);
  });

  it('超过间隔后允许再生成一次', () => {
    expect(
      shouldRefreshThumbnail({
        hasThumbnail: true,
        lastGeneratedAt: now - THUMBNAIL_MIN_INTERVAL_MS,
        savedSinceGenerated: true,
        now,
      }),
    ).toBe(true);
  });
});
