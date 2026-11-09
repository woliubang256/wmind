/**
 * 画布面板外壳：样式、配色、标记与结构。
 *
 * 只读预览时整块不挂载——验收标准 8 要求「只读查看器页面上不存在可编辑元素」，
 * 面板里全是可编辑控件，留在 DOM 里就算藏起来也算存在。
 *
 * Tab 列表用 `role="tablist"` + 方向键切换。只标 ARIA 不实现方向键是个常见的
 * 半成品：读屏会念「选项卡，1/3」，用户按方向键却什么都不会发生。
 */

import { useRef, type KeyboardEvent, type ReactNode, type Ref } from 'react';
import { Icon } from '@/components/ui/icon';
import { ToolbarButton } from '../toolbar-button';
import { cn } from '@/lib/utils';

export type PanelTab = 'style' | 'palette' | 'structure' | 'markers';

const TABS: { id: PanelTab; labelKey: string }[] = [
  { id: 'style', labelKey: 'editor.panel.tabs.style' },
  { id: 'palette', labelKey: 'editor.panel.tabs.palette' },
  { id: 'markers', labelKey: 'editor.panel.tabs.markers' },
  { id: 'structure', labelKey: 'editor.panel.tabs.structure' },
];

export function CanvasPanel({
  tab,
  onTab,
  onClose,
  toggleRef,
  label,
  tabLabel,
  children,
}: {
  tab: PanelTab;
  onTab: (tab: PanelTab) => void;
  onClose: () => void;
  toggleRef?: Ref<HTMLButtonElement>;
  label: string;
  /** `t` 的替身，避免把 i18n 依赖带进这个纯布局组件。 */
  tabLabel: (key: string) => string;
  children: ReactNode;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const index = TABS.findIndex((item) => item.id === tab);
    const delta = event.key === 'ArrowRight' ? 1 : -1;
    const next = (index + delta + TABS.length) % TABS.length;
    const target = TABS[next];
    if (!target) return;
    onTab(target.id);
    refs.current[next]?.focus();
  };

  return (
    <aside
      id="editor-canvas-panel"
      aria-label={label}
      className="flex w-72 shrink-0 flex-col border-l border-border/70 bg-card"
    >
      <div className="flex items-center gap-1 border-b border-border/70 px-1.5 py-1">
        <div role="tablist" aria-label={label} onKeyDown={onKeyDown} className="flex min-w-0 flex-1 gap-0.5 overflow-x-auto">
          {TABS.map((item, index) => {
            const active = item.id === tab;
            return (
              <button
                key={item.id}
                ref={(node) => {
                  refs.current[index] = node;
                }}
                role="tab"
                type="button"
                aria-selected={active}
                tabIndex={active ? 0 : -1}
                onClick={() => onTab(item.id)}
                className={cn(
                  'flex-1 rounded-md px-1.5 py-1 text-xs transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  active
                    ? 'bg-primary/10 font-semibold text-foreground'
                    : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                )}
              >
                {tabLabel(item.labelKey)}
              </button>
            );
          })}
        </div>
        <ToolbarButton
          ref={toggleRef}
          variant="ghost"
          size="icon"
          aria-label={tabLabel('editor.panel.hide')}
          aria-expanded={true}
          aria-controls="editor-canvas-panel"
          onClick={onClose}
          className="size-7 shrink-0"
        >
          <Icon name="panel-right-close" className="size-4" />
        </ToolbarButton>
      </div>

      <div
        role="tabpanel"
        aria-label={tabLabel(TABS.find((item) => item.id === tab)?.labelKey ?? '')}
        className="min-h-0 flex-1 overflow-y-auto p-3"
      >
        {children}
      </div>
    </aside>
  );
}
