/**
 * 「始终指向最新值」的 ref。
 *
 * 插件都要往 `<svg>` 上挂原生监听器，而监听器闭包里需要读到当前的
 * 选中态、布局、回调…… 直觉写法是把它们放进 `useEffect` 的依赖数组，
 * 但那会引出一个很难查的 bug：
 *
 * > 选中插件在 `pointerdown` 里调 `setSelection`，而 zustand 是**外部 store**，
 * > React 18 对 `useSyncExternalStore` 的通知会**同步**重渲染。重渲染让
 * > 依赖变化的其它插件跑 effect 清理，把刚注册的 `pointerdown` 监听器
 * > 摘掉了——而事件还在分发途中。于是同一个 `pointerdown`，排在前面的插件
 * > 收到了，排在后面的没收到。
 *
 * 症状极具迷惑性：拖拽在「节点已经被选中」时正常（选中插件不动选中态，
 * 没有重渲染），在「节点未被选中」时完全没反应。看起来像拖拽插件写错了，
 * 其实是它的事件被中途拆掉。
 *
 * 解决办法是让挂监听的 effect **只依赖 `svgRef`**（引用恒定），
 * 监听器里通过 `latest.current` 读最新值。副作用是监听器不再随每次渲染
 * 反复解绑重绑，2000 节点的图上这也是一笔可观的开销。
 */

import { useRef } from 'react';

export function useLatest<T>(value: T): { readonly current: T } {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}
