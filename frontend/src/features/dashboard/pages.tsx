/**
 * 还没实现的页面占位。
 *
 * 这里只剩「模板」一个 M5 后续交付。最近列表、回收站、分享分别搬去了
 * `features/maps/` 与 `features/share/`——留着旧实现会让同一个页面有两份
 * 代码，改一份不生效。
 */

import { Icon } from '@/components/ui/icon';

const titles: Record<string, string> = {
  templates: '模板',
};

export function PlaceholderPage({ page }: { page: keyof typeof titles }) {
  return (
    <section className="rounded-3xl border border-border/70 bg-card p-8 sm:p-10">
      <div className="inline-flex size-11 items-center justify-center rounded-2xl bg-primary/10 text-primary"><Icon name="waypoints" className="size-5" /></div>
      <h1 className="mt-5 text-2xl font-semibold tracking-tight">{titles[page]}</h1>
      <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">页面路由与应用外壳已搭建。该功能会在后续里程碑接入。</p>
    </section>
  );
}
