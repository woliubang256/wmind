import { describe, expect, it } from 'vitest';
import { CanvasGestureTracker, PointerSession, pinchedViewport } from './canvas-gestures';

const touch = (pointerId: number, x: number, y: number, canPan = false) => ({ pointerId, pointerType: 'touch', point: { x, y }, canPan });
const viewport = { x: 30, y: -20, zoom: 1 };

describe('pointer session ownership', () => {
  it('a second pointer cannot replace or finish a topic drag', () => {
    const session = new PointerSession<string>();
    expect(session.begin(1, 'first topic')).toBe(true);
    expect(session.begin(2, 'second topic')).toBe(false);
    expect(session.get(2)).toBeNull();
    expect(session.finish(2)).toBeNull();
    expect(session.finish(1)).toBe('first topic');
  });

  it('cancel discards the pending edit instead of returning a commit', () => {
    const session = new PointerSession<string>();
    session.begin(1, 'changed position');
    session.cancel();
    expect(session.finish(1)).toBeNull();
    expect(session.begin(2, 'new drag')).toBe(true);
  });
});

describe('canvas touch navigation', () => {
  it('keeps a topic single touch available to selection and dragging', () => {
    const gesture = new CanvasGestureTracker();
    expect(gesture.down(touch(1, 100, 100)).claimed).toBe(false);
    expect(gesture.move(1, { x: 140, y: 140 }).claimed).toBe(false);
    expect(gesture.up(1)).toEqual({ claimed: false, release: [] });
  });

  it('starts blank touch panning only beyond the screen-space threshold', () => {
    const gesture = new CanvasGestureTracker();
    expect(gesture.down(touch(1, 100, 100, true)).claimed).toBe(false);
    expect(gesture.move(1, { x: 102, y: 101 }).claimed).toBe(false);
    const moved = gesture.move(1, { x: 120, y: 110 });
    expect(moved.claimed).toBe(true);
    expect(moved.transform?.(viewport)).toEqual({ x: 50, y: -10, zoom: 1 });
    expect(gesture.suppressClicks).toBe(true);
    gesture.up(1);
    expect(gesture.suppressClicks).toBe(true);
    gesture.down(touch(2, 50, 50));
    expect(gesture.suppressClicks).toBe(false);
  });

  it('the second touch cancels editing before taking over both pointers', () => {
    const gesture = new CanvasGestureTracker();
    gesture.down(touch(1, 100, 100));
    const joined = gesture.down(touch(2, 200, 100));
    expect(joined.claimed).toBe(true);
    expect(joined.cancelEditing).toBe(true);
    expect(joined.capture).toEqual([1, 2]);
    const moved = gesture.move(2, { x: 300, y: 100 });
    expect(moved.transform?.({ x: 0, y: 0, zoom: 1 })).toEqual({ x: -100, y: -100, zoom: 2 });
  });

  it('continues panning with the remaining touch without restoring topic dragging', () => {
    const gesture = new CanvasGestureTracker();
    gesture.down(touch(1, 100, 100));
    gesture.down(touch(2, 200, 100));
    expect(gesture.up(1).claimed).toBe(true);
    const moved = gesture.move(2, { x: 215, y: 125 });
    expect(moved.claimed).toBe(true);
    expect(moved.transform?.(viewport)).toEqual({ x: 45, y: 5, zoom: 1 });
    gesture.up(2);
    expect(gesture.active).toBe(false);
  });

  it('ignores the third touch for geometry and rebases when a tracked finger lifts', () => {
    const gesture = new CanvasGestureTracker();
    gesture.down(touch(1, 100, 100));
    gesture.down(touch(2, 200, 100));
    gesture.down(touch(3, 400, 100));
    expect(gesture.move(3, { x: 450, y: 100 }).transform).toBeUndefined();
    gesture.up(1);
    const moved = gesture.move(2, { x: 200, y: 100 });
    expect(moved.transform?.(viewport) ?? viewport).toEqual(viewport);
  });

  it('cancels all pointer ownership and never resumes from a stale move/up', () => {
    const gesture = new CanvasGestureTracker();
    gesture.down(touch(1, 100, 100));
    gesture.down(touch(2, 200, 100));
    const cancelled = gesture.cancel();
    expect(cancelled.release).toEqual([1, 2]);
    expect(cancelled.cancelEditing).toBe(true);
    expect(gesture.move(1, { x: 300, y: 100 }).claimed).toBe(false);
    expect(gesture.up(2).claimed).toBe(false);
    expect(gesture.active).toBe(false);
  });

  it('leaves ordinary mouse input to PC selection but owns explicit Space/middle panning', () => {
    const gesture = new CanvasGestureTracker();
    expect(gesture.down({ pointerId: 1, pointerType: 'mouse', point: { x: 0, y: 0 }, canPan: true }).claimed).toBe(false);
    expect(gesture.move(1, { x: 100, y: 100 }).claimed).toBe(false);
    gesture.up(1);
    const start = gesture.down({ pointerId: 1, pointerType: 'mouse', point: { x: 10, y: 10 }, canPan: false, forcePan: true });
    expect(start.claimed).toBe(true);
    expect(start.cancelEditing).toBe(true);
    expect(gesture.move(2, { x: 30, y: 30 }).claimed).toBe(false);
    expect(gesture.move(1, { x: 30, y: 40 }).transform?.(viewport)).toEqual({ x: 50, y: 10, zoom: 1 });
    gesture.up(1);
  });

  it('cancels a pending mouse edit before the first touch and ignores stale mouse completion', () => {
    const gesture = new CanvasGestureTracker();
    gesture.down({ pointerId: 1, pointerType: 'mouse', point: { x: 10, y: 10 }, canPan: false });
    expect(gesture.down(touch(2, 100, 100))).toEqual({ claimed: false, cancelEditing: true, release: [1] });
    expect(gesture.move(1, { x: 30, y: 30 }).claimed).toBe(false);
    expect(gesture.up(1).claimed).toBe(false);
    expect(gesture.down({ pointerId: 1, pointerType: 'mouse', point: { x: 10, y: 10 }, canPan: false }).claimed).toBe(true);
    expect(gesture.down(touch(3, 200, 100)).claimed).toBe(true);
  });

  it('never lets a touch replace an active Space/middle mouse pan', () => {
    const gesture = new CanvasGestureTracker();
    gesture.down({ pointerId: 1, pointerType: 'mouse', point: { x: 10, y: 10 }, canPan: false, forcePan: true });
    expect(gesture.down(touch(2, 100, 100)).claimed).toBe(true);
    expect(gesture.hasPointer(2)).toBe(false);
    expect(gesture.move(1, { x: 30, y: 40 }).transform?.(viewport)).toEqual({ x: 50, y: 10, zoom: 1 });
  });

  it('keeps Space panning available to touchscreens with an attached keyboard', () => {
    const gesture = new CanvasGestureTracker();
    expect(gesture.down({ ...touch(1, 100, 100), forcePan: true }).claimed).toBe(true);
    expect(gesture.move(1, { x: 120, y: 130 }).transform?.(viewport)).toEqual({ x: 50, y: 10, zoom: 1 });
  });

  it('does not accumulate clamp drift when both fingers translate at a zoom limit', () => {
    for (const [zoom, dx] of [[4, -10], [4, 10], [0.2, -10], [0.2, 10]] as const) {
      const gesture = new CanvasGestureTracker();
      gesture.down(touch(1, 100, 100));
      gesture.down(touch(2, 200, 100));
      let current: { x: number; y: number; zoom: number } = { x: 0, y: 0, zoom };
      current = gesture.move(1, { x: 100 + dx, y: 100 }).transform!(current);
      current = gesture.move(2, { x: 200 + dx, y: 100 }).transform!(current);
      expect(current.zoom).toBeCloseTo(zoom);
      expect(current.x).toBeCloseTo(dx);
      expect(current.y).toBeCloseTo(0);
    }
  });
});

describe('pinch viewport geometry', () => {
  it('keeps the world point under the moving midpoint fixed relative to the fingers', () => {
    const next = pinchedViewport(viewport, { x: 100, y: 100 }, { x: 130, y: 150 }, 100, 200);
    expect((next.x - 130) / next.zoom).toBe((viewport.x - 100) / viewport.zoom);
    expect((next.y - 150) / next.zoom).toBe((viewport.y - 100) / viewport.zoom);
    expect(next.zoom).toBe(2);
  });

  it('keeps midpoint panning at both zoom limits and tolerates coincident fingers', () => {
    expect(pinchedViewport({ x: 0, y: 0, zoom: 4 }, { x: 100, y: 100 }, { x: 120, y: 130 }, 100, 200))
      .toEqual({ x: 20, y: 30, zoom: 4 });
    expect(pinchedViewport({ x: 0, y: 0, zoom: 0.2 }, { x: 100, y: 100 }, { x: 120, y: 130 }, 100, 50))
      .toEqual({ x: 20, y: 30, zoom: 0.2 });
    expect(pinchedViewport(viewport, { x: 100, y: 100 }, { x: 100, y: 100 }, 0, 0)).toEqual(viewport);
  });
});
