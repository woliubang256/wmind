/**
 * 关于弹窗（仅桌面端）。
 *
 * 一屏交代清楚四件事：这是什么、当前版本、有没有新版本、去哪看更多。
 * 版本号来自壳注入的 `window.__WMIND__.version`（构建时由 VERSION 写入），
 * 与安装包、更新清单同源。
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { LoadingImage } from '@/components/ui/loading-image';
import { Modal } from '@/components/ui/modal';
import {
  checkForUpdates,
  desktopRuntime,
  openDeployGuide,
  openProjectPage,
  type UpdateCheck,
} from '@/lib/desktop';
import { UpdateDialog } from '@/features/updates/update-dialog';

export function AboutDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const [checking, setChecking] = useState(false);
  const [found, setFound] = useState<UpdateCheck | null>(null);
  const [updateOpen, setUpdateOpen] = useState(false);
  const version = desktopRuntime()?.version || '—';

  const check = async () => {
    setChecking(true);
    try {
      const result = await checkForUpdates();
      if (!result.enabled) {
        toast.info(t('desktop.update.unsupported'));
        return;
      }
      if (!result.available) {
        toast.success(t('desktop.update.upToDate'));
        return;
      }
      setFound(result);
      setUpdateOpen(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('desktop.update.error'));
    } finally {
      setChecking(false);
    }
  };

  const openLink = (action: () => Promise<unknown>) => {
    void action().catch((error) => {
      toast.error(error instanceof Error ? error.message : t('desktop.about.openFailed'));
    });
  };

  return (
    <>
      <Modal open={open} title={t('desktop.about.title')} onClose={onClose}>
        <div className="space-y-5">
          <div className="flex items-start gap-3">
            <LoadingImage
              src="/wmind-logo.jpg"
              alt=""
              containerClassName="size-12 shrink-0 overflow-hidden rounded-xl"
              className="size-full object-cover"
            />
            <div className="min-w-0">
              <p className="text-base font-semibold">Wmind</p>
              <p className="mt-0.5 text-sm text-muted-foreground">{t('desktop.about.tagline')}</p>
            </div>
          </div>

          <p className="text-sm leading-6 text-muted-foreground">{t('desktop.about.description')}</p>

          <dl className="grid gap-1.5 text-sm">
            <div className="flex gap-2">
              <dt className="shrink-0 text-muted-foreground">{t('desktop.about.version')}</dt>
              <dd className="font-medium tabular-nums">v{version}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="shrink-0 text-muted-foreground">{t('desktop.about.license')}</dt>
              <dd>MIT</dd>
            </div>
          </dl>

          <div className="flex flex-wrap gap-2">
            <Button variant="outline" loading={checking} onClick={() => void check()}>
              {checking ? t('desktop.update.checking') : t('desktop.update.check')}
            </Button>
            <Button variant="outline" onClick={() => openLink(openProjectPage)}>
              <Icon name="link" className="size-4" />
              {t('desktop.about.project')}
            </Button>
            <Button variant="outline" onClick={() => openLink(openDeployGuide)}>
              <Icon name="file" className="size-4" />
              {t('desktop.about.deployGuide')}
            </Button>
          </div>
        </div>
      </Modal>
      <UpdateDialog update={found} open={updateOpen} onClose={() => setUpdateOpen(false)} />
    </>
  );
}
