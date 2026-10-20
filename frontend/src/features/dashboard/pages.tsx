/**
 * 还没实现的页面占位。
 *
 * 这里只剩「模板」和「我的分享」两个 M5 后续交付。最近列表与回收站已经搬去
 * `features/maps/`——留着旧实现会让同一个页面有两份代码，改一份不生效。
 */

import { Icon } from '@/components/ui/icon';

const titles: Record<string, string> = {
  templates: '模板',
  shares: '我的分享',
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

export function PublicSharePage() {
  return (
    <section className="mx-auto max-w-3xl rounded-3xl border border-border bg-card p-8 text-center sm:p-12">
      <Icon name="waypoints" className="mx-auto size-10 text-primary" />
      <h1 className="mt-5 text-2xl font-semibold">公开分享</h1>
      <p className="mt-2 text-sm text-muted-foreground">分享查看器将在导图编辑器完成后接入。</p>
    </section>
  );
}
