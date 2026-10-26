import type { Point } from '../../layout/types';
import type { Viewport } from '../viewer-types';

export const MIN_ZOOM = 0.2;
export const MAX_ZOOM = 4;
const PAN_THRESHOLD = 4;

/** A drag may only be changed or completed by the pointer that started it. */
export class PointerSession<T> {
  private pointerId: number | null = null;
  private value: T | null = null;

  begin(pointerId: number, value: T): boolean {
    if (this.pointerId !== null) return false;
    this.pointerId = pointerId;
    this.value = value;
    return true;
  }

  get(pointerId: number): T | null { return this.pointerId === pointerId ? this.value : null; }
  current(): T | null { return this.value; }
  get id(): number | null { return this.pointerId; }
  finish(pointerId: number): T | null {
    const value = this.get(pointerId);
    if (this.pointerId === pointerId) this.cancel();
    return value;
  }
  cancel(): void { this.pointerId = null; this.value = null; }
}

export function pinchedViewport(prev: Viewport, oldCenter: Point, newCenter: Point, oldDistance: number, newDistance: number): Viewport {
  const factor = oldDistance > 0 && newDistance > 0 ? newDistance / oldDistance : 1;
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, prev.zoom * factor));
  const worldX = (oldCenter.x - prev.x) / prev.zoom;
  const worldY = (oldCenter.y - prev.y) / prev.zoom;
  return { zoom, x: newCenter.x - worldX * zoom, y: newCenter.y - worldY * zoom };
}

interface PointerStart {
  pointerId: number;
  pointerType: string;
  point: Point;
  canPan: boolean;
  forcePan?: boolean;
}

interface TouchPoint { point: Point; origin: Point; canPan: boolean }
interface PinchBase { ids: number[]; center: Point; distance: number; viewport?: Viewport }
export interface GestureChange {
  claimed: boolean;
  cancelEditing?: boolean;
  capture?: number[];
  release?: number[];
  transform?: (prev: Viewport) => Viewport;
}
const UNCLAIMED: GestureChange = { claimed: false };
const center = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const translated = (from: Point, to: Point) => (prev: Viewport): Viewport => ({ ...prev, x: prev.x + to.x - from.x, y: prev.y + to.y - from.y });

/** Pure pointer arbitration: ordinary mouse input remains with the editing plugins. */
export class CanvasGestureTracker {
  private touches = new Map<number, TouchPoint>();
  private touchOwned = false;
  private mouse: { id: number; point: Point; owned: boolean } | null = null;
  private pinch: PinchBase | null = null;
  suppressClicks = false;

  get active(): boolean { return this.touchOwned || Boolean(this.mouse?.owned); }
  hasPointer(pointerId: number): boolean { return this.touches.has(pointerId) || this.mouse?.id === pointerId; }

  private rebasePinch(): void {
    const ids = [...this.touches.keys()].slice(0, 2);
    if (ids.length < 2) { this.pinch = null; return; }
    const first = this.touches.get(ids[0]!)!.point, second = this.touches.get(ids[1]!)!.point;
    this.pinch = { ids, center: center(first, second), distance: distance(first, second) };
  }

  down(input: PointerStart): GestureChange {
    if (this.touches.size === 0 && this.mouse === null) this.suppressClicks = false;
    if (input.pointerType !== 'touch') {
      if (this.touches.size > 0) { this.suppressClicks = true; return { claimed: true }; }
      if (this.mouse) return { claimed: this.mouse.id !== input.pointerId || this.mouse.owned };
      this.mouse = { id: input.pointerId, point: input.point, owned: Boolean(input.forcePan) };
      if (!input.forcePan) return UNCLAIMED;
      this.suppressClicks = true;
      return { claimed: true, cancelEditing: true, capture: [input.pointerId] };
    }
    if (this.mouse?.owned) return { claimed: true };
    // A touch starts a new input sequence; discard a pending mouse edit before handing over.
    const cancelledMouse = this.mouse?.id;
    this.mouse = null;
    if (this.touches.has(input.pointerId)) return { claimed: this.touchOwned };
    this.touches.set(input.pointerId, { point: input.point, origin: input.point, canPan: input.canPan });
    if (this.touches.size < 2) {
      if (input.forcePan) {
        this.touchOwned = true;
        this.suppressClicks = true;
        return { claimed: true, cancelEditing: true, capture: [input.pointerId], release: cancelledMouse === undefined ? [] : [cancelledMouse] };
      }
      return cancelledMouse === undefined ? UNCLAIMED : { claimed: false, cancelEditing: true, release: [cancelledMouse] };
    }
    const takeover = !this.touchOwned;
    this.touchOwned = true;
    this.suppressClicks = true;
    if (this.touches.size === 2) this.rebasePinch();
    return { claimed: true, cancelEditing: takeover, capture: [...this.touches.keys()] };
  }

  move(pointerId: number, point: Point): GestureChange {
    if (this.mouse?.id === pointerId) {
      if (!this.mouse.owned) return UNCLAIMED;
      const previous = this.mouse.point;
      this.mouse.point = point;
      return { claimed: true, transform: translated(previous, point) };
    }
    const touch = this.touches.get(pointerId);
    if (!touch) return UNCLAIMED;
    const ids = [...this.touches.keys()].slice(0, 2);
    const oldPoint = touch.point;
    touch.point = point;
    if (!this.touchOwned) {
      if (!touch.canPan || distance(touch.origin, point) < PAN_THRESHOLD) return UNCLAIMED;
      this.touchOwned = true;
      this.suppressClicks = true;
      return { claimed: true, cancelEditing: true, capture: [pointerId], transform: translated(touch.origin, point) };
    }
    if (ids.length < 2) return { claimed: true, transform: translated(oldPoint, point) };
    if (!ids.includes(pointerId) || (oldPoint.x === point.x && oldPoint.y === point.y)) return { claimed: true };
    const nextPair = ids.map((id) => this.touches.get(id)!.point);
    const newCenter = center(nextPair[0]!, nextPair[1]!);
    const newDistance = distance(nextPair[0]!, nextPair[1]!);
    const base = this.pinch!;
    // Absolute geometry avoids losing scale when one pointer briefly hits a clamp before
    // the second pointer from the same touchmove event arrives.
    return { claimed: true, transform: (prev) => {
      base.viewport ??= prev;
      return pinchedViewport(base.viewport, base.center, newCenter, base.distance, newDistance);
    } };
  }

  up(pointerId: number): GestureChange {
    if (this.mouse?.id === pointerId) {
      const claimed = this.mouse.owned;
      this.mouse = null;
      return { claimed, release: claimed ? [pointerId] : [] };
    }
    if (!this.touches.has(pointerId)) return UNCLAIMED;
    const claimed = this.touchOwned;
    this.touches.delete(pointerId);
    if (this.touches.size === 0) this.touchOwned = false;
    if (this.pinch?.ids.includes(pointerId)) this.rebasePinch();
    return { claimed, release: claimed ? [pointerId] : [] };
  }

  cancel(): GestureChange {
    const release = [...this.touches.keys(), ...(this.mouse ? [this.mouse.id] : [])];
    const claimed = this.active;
    this.touches.clear();
    this.touchOwned = false;
    this.mouse = null;
    this.pinch = null;
    if (release.length) this.suppressClicks = true;
    return { claimed, cancelEditing: true, release };
  }
}

interface CanvasGestureRuntime {
  tracker: CanvasGestureTracker;
  cancelListeners: Set<() => void>;
  cancelNavigation?: () => void;
}
const runtimes = new WeakMap<SVGSVGElement, CanvasGestureRuntime>();

export function canvasGestures(svg: SVGSVGElement): CanvasGestureRuntime {
  let runtime = runtimes.get(svg);
  if (!runtime) {
    runtime = { tracker: new CanvasGestureTracker(), cancelListeners: new Set() };
    runtimes.set(svg, runtime);
  }
  return runtime;
}

export function subscribeCanvasGestureCancel(svg: SVGSVGElement, cancel: () => void): () => void {
  const runtime = canvasGestures(svg);
  runtime.cancelListeners.add(cancel);
  return () => { runtime.cancelListeners.delete(cancel); };
}

/** Also used by the editor's outer React capture handler, which runs before SVG listeners. */
export function shouldSuppressCanvasClick(event: { target: EventTarget | null; detail: number }): boolean {
  if (event.detail === 0 || !(event.target instanceof Element)) return false;
  const svg = event.target.closest('svg');
  return svg instanceof SVGSVGElement && Boolean(runtimes.get(svg)?.tracker.suppressClicks);
}

export function forgetCanvasGestures(svg: SVGSVGElement): void { runtimes.delete(svg); }
