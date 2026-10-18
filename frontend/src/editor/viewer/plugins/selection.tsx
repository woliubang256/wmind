/**
 * 选中插件（仅编辑器）。
 *
 * 用事件委托而不是给每个节点挂 handler：1000 个节点就是 1000 个监听器，
 * 而且每次布局变化都要重新绑定。委托到 `<svg>` 上只有一个监听器，
 * 靠 `data-topic-id` 反查目标——命中测试交给浏览器做，天然处理了
 * 形状、遮挡与缩放变换（docs/05 §4.6.1）。
 */

import { useEffect } from 'react';
import { useViewer } from '../viewer-context';
import { useLatest } from './use-latest';

export function SelectionPlugin() {
  const { svgRef } = useViewer();
  // 监听器只挂一次，值从 latest 读：否则本插件自己的 setSelection 会在
  // 事件分发途中触发重渲染，把后续插件的监听器拆掉（见 use-latest.ts）。
  const latest = useLatest(useViewer());

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return undefined;

    const onPointerDown = (event: PointerEvent) => {
      // 只处理主键。中键是平移，右键留给上下文菜单。
      if (event.button !== 0) return;
      const target = event.target as Element | null;
      if (!target) return;
      // 折叠按钮自己会 stopPropagation，这里再挡一次，防止捕获阶段的顺序变化。
      if (target.closest('[data-collapse-toggle]')) return;

      const { selection, setSelection, toggleSelection } = latest.current;

      const node = target.closest('[data-topic-id]');
      if (node) {
        const id = node.getAttribute('data-topic-id');
        if (!id) return;
        if (event.shiftKey || event.metaKey || event.ctrlKey) toggleSelection(id);
        // 点在**已选中**的节点上且没有修饰键时保持选区不动。
        // 多选之后要能把这一组一起拖走，而 pointerdown 就把选区收敛成一个
        // 的话，拖拽插件拿到的永远只有一个节点。收敛由拖拽插件在
        // 「没越过阈值 = 一次点击」时做。
        else if (!selection.has(id)) setSelection([id]);
        return;
      }

      // 点空白清空选中。放在 pointerdown 而不是 click：
      // 框选也从这个事件开始，两者共用同一起点。
      setSelection([]);
    };

    svg.addEventListener('pointerdown', onPointerDown);
    return () => svg.removeEventListener('pointerdown', onPointerDown);
  }, [svgRef, latest]);

  return null;
}
