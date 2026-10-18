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

export function SelectionPlugin() {
  const { svgRef, setSelection, toggleSelection } = useViewer();

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return undefined;

    const onPointerDown = (event: PointerEvent) => {
      // 只处理主键。中键是平移，右键留给 M2.4 的上下文菜单。
      if (event.button !== 0) return;
      const target = event.target as Element | null;
      if (!target) return;
      // 折叠按钮自己会 stopPropagation，这里再挡一次，防止捕获阶段的顺序变化。
      if (target.closest('[data-collapse-toggle]')) return;

      const node = target.closest('[data-topic-id]');
      if (node) {
        const id = node.getAttribute('data-topic-id');
        if (!id) return;
        if (event.shiftKey || event.metaKey || event.ctrlKey) toggleSelection(id);
        else setSelection([id]);
        return;
      }

      // 点空白清空选中。放在 pointerdown 而不是 click：
      // 拖拽框选（M2.5）也从这个事件开始，两者共用同一起点。
      setSelection([]);
    };

    svg.addEventListener('pointerdown', onPointerDown);
    return () => svg.removeEventListener('pointerdown', onPointerDown);
  }, [svgRef, setSelection, toggleSelection]);

  return null;
}
