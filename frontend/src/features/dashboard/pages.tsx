import { lazy, Suspense, useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { Icon } from '@/components/ui/icon';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { mapApi } from '@/lib/api/maps';
import { formatBytes } from '@/lib/format';
import { IMPORT_LIMITS } from '@/editor/import/limits';
import { createStarterDocument } from '@/features/editor/demo-document';
import { useSiteConfig } from '@/features/site/use-site-config';

/**
 * 导入模块按需加载。
 *
 * 里面装着三种格式的解析器和 fflate（解压），加起来比整个首页还大，而绝大多数
 * 会话根本不会导入。静态引入会让每个打开首页的人都先下载它。
 */
const ImportDialog = lazy(() => import('./import-dialog').then((module) => ({ default: module.ImportDialog })));

const titles: Record<string, string> = {
  templates: '模板',
  trash: '回收站',
  shares: '我的分享',
  account: '个人设置',
  users: '用户管理',
  settings: '网站设置',
};

export function RecentPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { config } = useSiteConfig();
  const [creating, setCreating] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [dropping, setDropping] = useState(false);

  /**
   * 新建导图：先落库再进编辑器。
   *
   * 顺序不能反——先跳到一个临时 uid 再让编辑器「保存时创建」的话，编辑器要
   * 多一条「这张图还不存在」的分支，而自动保存在第一秒就会跑起来。先 POST
   * 拿到真 uid，编辑器就只有「读取并保存」一种状态。
   */
  const createMap = async () => {
    setCreating(true);
    try {
      const created = await mapApi.create({ title: '未命名导图', document: createStarterDocument() });
      navigate(`/maps/${created.uid}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '创建导图失败。');
    } finally {
      setCreating(false);
    }
  };

  /**
   * 只有真的拖了**文件**才接管事件。
   *
   * 不判断 `types` 的话，在页面里选中文字一拖，整个页面就会变成「投放区」，
   * 松手时把浏览器默认的拖拽行为吃掉——用户会发现选中的文字拖不动了。
   */
  const hasFiles = (event: React.DragEvent) => config.importEnabled && event.dataTransfer.types.includes('Files');

  return (
    <div
      className="relative space-y-8"
      onDragOver={(event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        setDropping(true);
      }}
      onDragLeave={(event) => {
        // 子元素之间移动也会触发 dragleave，只有真正离开整块区域才算离开。
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setDropping(false);
      }}
      onDrop={(event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        setDropping(false);
        const file = event.dataTransfer.files[0];
        if (!file) return;
        setPendingFile(file);
        setImportOpen(true);
      }}
    >
      {dropping ? (
        <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center rounded-3xl border-2 border-dashed border-primary bg-background/85 backdrop-blur-sm">
          <div className="text-center">
            <Icon name="upload" className="mx-auto size-8 text-primary" />
            <p className="mt-3 text-sm font-medium">{t('import.dialog.dropTitle')}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t('import.dialog.formats', { limit: formatBytes(IMPORT_LIMITS.maxInputBytes) })}
            </p>
          </div>
        </div>
      ) : null}

      <section className="relative overflow-hidden rounded-3xl border border-border/70 bg-card p-7 sm:p-10">
        <div className="relative z-10 max-w-2xl">
          <div className="mb-4 inline-flex items-center gap-2 rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary"><Icon name="sparkles" className="size-3.5" />想法，从这里开始</div>
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{t('home.welcome', { name: 'wmind' })}</h1>
          <p className="mt-3 max-w-lg text-sm leading-6 text-muted-foreground sm:text-base">{t('home.subtitle')}</p>
          <div className="mt-6 flex flex-wrap items-center gap-2">
            <Button onClick={() => void createMap()} disabled={creating}>
              <Icon name="file-plus" className="size-4" />{t('home.create')}
            </Button>
            {config.importEnabled ? (
              <Button variant="outline" onClick={() => setImportOpen(true)}>
                <Icon name="upload" className="size-4" />{t('import.dialog.title')}
              </Button>
            ) : null}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">{t('home.createHint')}</p>
        </div>
        <div className="pointer-events-none absolute -right-12 -top-16 hidden size-80 rounded-full bg-primary/5 blur-3xl sm:block" />
        <Icon name="waypoints" className="pointer-events-none absolute -bottom-10 right-8 hidden size-44 text-primary/10 sm:block" strokeWidth={1} />
      </section>

      <section className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div><h2 className="text-lg font-semibold">最近的导图</h2><p className="mt-1 text-sm text-muted-foreground">继续整理正在进行的想法。</p></div>
          <Button variant="outline" size="sm" disabled><Icon name="search" className="size-4" />搜索</Button>
        </div>
        <div className="grid min-h-64 place-items-center rounded-3xl border border-dashed border-border bg-card/40 px-6 py-12 text-center">
          <div className="max-w-sm">
            <span className="mx-auto grid size-12 place-items-center rounded-2xl bg-secondary text-secondary-foreground"><Icon name="files" className="size-5" /></span>
            <h3 className="mt-4 font-medium">{t('home.empty')}</h3>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">{t('home.building')}</p>
            <Button variant="ghost" size="sm" className="mt-3" disabled>了解功能路线<Icon name="arrow-right" className="size-4" /></Button>
          </div>
        </div>
      </section>

      <div className="grid gap-4 sm:grid-cols-3">
        {[
          { icon: 'clock' as const, label: '最近打开', value: '—' },
          { icon: 'waypoints' as const, label: '我的导图', value: '—' },
          { icon: 'trash' as const, label: '回收站', value: '—' },
        ].map(({ icon, label, value }) => (
          <div key={label} className="rounded-2xl border border-border/70 bg-card p-4">
            <div className="flex items-center justify-between text-sm text-muted-foreground"><span>{label}</span><Icon name={icon} className="size-4" /></div>
            <p className="mt-3 text-2xl font-semibold">{value}</p>
          </div>
        ))}
      </div>

      {importOpen ? (
        <Suspense fallback={null}>
          <ImportDialog
            open
            onClose={() => setImportOpen(false)}
            initialFile={pendingFile}
            onFileConsumed={() => setPendingFile(null)}
          />
        </Suspense>
      ) : null}
    </div>
  );
}

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
