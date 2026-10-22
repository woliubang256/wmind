/**
 * 画布面板外壳：「样式 / 演说 / 画布」三个 Tab。
 *
 * 只读预览时整块不挂载——验收标准 8 要求「只读查看器页面上不存在可编辑元素」，
 * 面板里全是可编辑控件，留在 DOM 里就算藏起来也算存在。
 *
 * Tab 列表用 `role="tablist"` + 方向键切换。只标 ARIA 不实现方向键是个常见的
 * 半成品：读屏会念「选项卡，1/3」，用户按方向键却什么都不会发生。
 */

import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { Icon } from '@/components/ui/icon';
import { cn } from '@/lib/utils';

export type PanelTab = 'style' | 'palette' | 'speaker' | 'structure';

const TABS: { id: PanelTab; labelKey: string }[] = [
  { id: 'style', labelKey: 'editor.panel.tabs.style' },
  { id: 'palette', labelKey: 'editor.panel.tabs.palette' },
  { id: 'structure', labelKey: 'editor.panel.tabs.structure' },
  { id: 'speaker', labelKey: 'editor.panel.tabs.speaker' },
];

export function CanvasPanel({
  tab,
  onTab,
  onClose,
  label,
  tabLabel,
  children,
}: {
  tab: PanelTab;
  onTab: (tab: PanelTab) => void;
  onClose: () => void;
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
      aria-label={label}
      className="flex w-72 shrink-0 flex-col border-l border-border/70 bg-card"
    >
      <div className="flex items-center gap-1 border-b border-border/70 px-1.5 py-1">
        <div role="tablist" aria-label={label} onKeyDown={onKeyDown} className="flex flex-1 gap-0.5">
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
                  'flex-1 rounded-md px-2 py-1 text-xs transition-colors',
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
        <button
          type="button"
          aria-label={tabLabel('editor.panel.close')}
          onClick={onClose}
          className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        >
          <Icon name="chevron-right" className="size-4" />
        </button>
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
