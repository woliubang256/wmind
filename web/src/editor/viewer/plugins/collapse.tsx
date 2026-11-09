/**
 * 折叠 / 展开插件。
 *
 * 只读分享页也挂这个——「缩放与折叠正常可用」是只读查看器的验收标准之一
 * （docs/08 §4.2 第 8 条）。作者会持久化主题的 collapsed 字段；分享宿主
 * 仅调整独立临时副本，不写回作者文档，因此只读分享也可安全折叠。
 *
 * 徽标本身由 `TopicNode` 渲染（放在节点自己的 `<g>` 里才能用 CSS `:hover`
 * 控制显隐），这个插件委托点击和只读按钮的 Enter / Space。
 */

import { useEffect } from 'react';
import { useViewer } from '../viewer-context';
import { useLatest } from './use-latest';
import { shouldSuppressCanvasClick } from './canvas-gestures';

export function CollapsePlugin() {
  const { svgRef } = useViewer();
  const latest = useLatest(useViewer());

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return undefined;

    const onClick = (event: MouseEvent) => {
      if (shouldSuppressCanvasClick(event)) return;
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

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey || (event.key !== 'Enter' && event.key !== ' ')) return;
      const target = event.target as Element | null;
      const toggle = target?.closest('[data-collapse-toggle][role="button"][tabindex="0"]');
      const id = toggle?.getAttribute('data-collapse-toggle');
      if (!id) return;
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) latest.current.toggleCollapse(id);
    };

    // 用捕获阶段：选中插件在冒泡阶段监听，先到先得能保证折叠优先。
    svg.addEventListener('click', onClick, true);
    svg.addEventListener('keydown', onKeyDown, true);
    return () => {
      svg.removeEventListener('click', onClick, true);
      svg.removeEventListener('keydown', onKeyDown, true);
    };
  }, [svgRef, latest]);

  return null;
}
