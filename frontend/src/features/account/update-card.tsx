/**
 * 应用更新卡片（仅桌面端）。
 *
 * 自动检查在启动后跑一次（见 UpdateDialog 的 useAutoUpdateCheck）；这里给
 * 「手动检查」的入口，并把当前版本显示出来——用户报问题时第一句话常常是
 * 「我是哪个版本」，把它放在设置里省掉一次追问。
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Panel } from '@/components/ui/panel';
import { checkForUpdates, desktopRuntime, type UpdateCheck } from '@/lib/desktop';
import { UpdateDialog } from '@/features/updates/update-dialog';

export function UpdateCard() {
  const { t } = useTranslation();
  const [checking, setChecking] = useState(false);
  const [found, setFound] = useState<UpdateCheck | null>(null);
  const [open, setOpen] = useState(false);
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
      setOpen(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('desktop.update.error'));
    } finally {
      setChecking(false);
    }
  };

  return (
    <Panel title={t('desktop.update.check')} bodyClassName="p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {t('desktop.update.current')}：<span className="font-medium text-foreground">v{version}</span>
        </p>
        <Button variant="outline" loading={checking} onClick={() => void check()}>
          {checking ? t('desktop.update.checking') : t('desktop.update.check')}
        </Button>
      </div>
      <UpdateDialog update={found} open={open} onClose={() => setOpen(false)} />
    </Panel>
  );
}
