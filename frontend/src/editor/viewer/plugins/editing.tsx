/**
 * 双击进入编辑（仅编辑器）。
 *
 * 这里只负责「进入」编辑态；输入框的渲染、提交与取消都在
 * `MindMapViewer` 里（它必须知道 viewport 才能把输入框摆到正确位置）。
 *
 * 键盘的 F2 / Enter 入口在 M2.4 的键盘插件里，与这里共用 `beginEdit`。
 */

import { useEffect } from 'react';
import { useViewer } from '../viewer-context';
import { useLatest } from './use-latest';

export function EditingPlugin() {
  const { svgRef, readOnly } = useViewer();
  const latest = useLatest(useViewer());

  useEffect(() => {
    if (readOnly) return undefined;
    const svg = svgRef.current;
    if (!svg) return undefined;

    const onDoubleClick = (event: MouseEvent) => {
      const target = event.target as Element | null;
      const node = target?.closest('[data-topic-id]');
      if (!node) return;
      const id = node.getAttribute('data-topic-id');
      if (!id) return;
      event.preventDefault();
      latest.current.beginEdit(id);
    };

    svg.addEventListener('dblclick', onDoubleClick);
    return () => svg.removeEventListener('dblclick', onDoubleClick);
  }, [svgRef, readOnly, latest]);

  return null;
}
