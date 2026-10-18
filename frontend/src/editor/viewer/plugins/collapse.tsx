/**
 * 折叠 / 展开插件。
 *
 * 只读分享页也挂这个——「缩放与折叠正常可用」是只读查看器的验收标准之一
 * （docs/08 §4.2 第 8 条）。折叠不改变文档内容，只是视图状态，
 * 所以它在只读模式里也是安全的。
 *
 * 徽标本身由 `TopicNode` 渲染（放在节点自己的 `<g>` 里才能用 CSS `:hover`
 * 控制显隐），这个插件只负责把点击事件接出来。
 */

import { useEffect } from 'react';
import { useViewer } from '../viewer-context';
import { useLatest } from './use-latest';

export function CollapsePlugin() {
  const { svgRef } = useViewer();
  const latest = useLatest(useViewer());

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return undefined;

    const onClick = (event: MouseEvent) => {
      const target = event.target as Element | null;
      const toggle = target?.closest('[data-collapse-toggle]');
      if (!toggle) return;
      const id = toggle.getAttribute('data-collapse-toggle');
      if (!id) return;
      // 阻止冒泡：否则点击徽标会被选中插件当成「选中节点」，
      // 折叠按钮就不只是折叠，还顺带改了选中态。
      event.preventDefault();
      event.stopPropagation();
      latest.current.toggleCollapse(id);
    };

    // 用捕获阶段：选中插件在冒泡阶段监听，先到先得能保证折叠优先。
    svg.addEventListener('click', onClick, true);
    return () => svg.removeEventListener('click', onClick, true);
  }, [svgRef, latest]);

  return null;
}
