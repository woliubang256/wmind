/**
 * 应用更新弹窗（仅桌面端）。
 *
 * 一条链走完三件事：检查到新版本 → 显示发布说明 → 下载（带进度）→ 提示重启。
 *
 * 几个刻意的选择：
 *
 * - **发布说明按纯文本渲染**（保留换行），不引 Markdown 渲染器：说明里只有
 *   列表和段落，为它塞进一个 Markdown 解析器不划算，而且渲染器会把
 *   说明里的尖括号当成 HTML。
 * - **进度用轮询而不是流**：桌面接口是普通的 JSON 端点，`Install` 在 Go 侧
 *   跑在后台协程里，前端每 400ms 取一次进度，比维护一条 SSE 简单得多。
 * - **下载完成后不自动重启**：用户可能正在编辑。给一个「立即重启」按钮，
 *   由用户决定时机（文档已自动保存，但让人自己按更稳妥）。
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Modal } from '@/components/ui/modal';
import { formatBytes } from '@/lib/format';
import {
  checkForUpdates,
  fetchUpdateProgress,
  installUpdate,
  isDesktop,
  relaunchApp,
  type UpdateCheck,
  type UpdateProgress,
} from '@/lib/desktop';

const POLL_INTERVAL_MS = 400;

export function UpdateDialog({
  update,
  open,
  onClose,
}: {
  update: UpdateCheck | null;
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [progress, setProgress] = useState<UpdateProgress>({ phase: 'idle', downloaded: 0, total: 0 });
  const [installing, setInstalling] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  // 安装中才轮询；完成后停在 ready，等用户点重启。
  useEffect(() => {
    if (!installing) return undefined;
    let cancelled = false;
    const timer = setInterval(async () => {
      try {
        const next = await fetchUpdateProgress();
        if (cancelled) return;
        setProgress(next);
        if (next.phase === 'ready') {
          setInstalling(false);
        } else if (next.phase === 'error') {
          setInstalling(false);
          setFailed(next.error ?? t('desktop.update.failed'));
        }
      } catch {
        // 一次轮询失败不代表安装失败：下一轮继续。
      }
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [installing, t]);

  const percent = progress.total > 0 ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100)) : 0;

  const start = async () => {
    setFailed(null);
    setInstalling(true);
    try {
      await installUpdate();
    } catch (error) {
      setInstalling(false);
      setFailed(error instanceof Error ? error.message : t('desktop.update.failed'));
    }
  };

  const restart = async () => {
    try {
      await relaunchApp();
    } catch {
      // 进程正在退出，请求断开是预期内的。
    }
  };

  const ready = progress.phase === 'ready';

  return (
    <Modal
      open={open}
      title={t('desktop.update.title', { version: update?.newVersion ?? '' })}
      onClose={installing ? () => undefined : onClose}
      footer={
        ready ? (
          <>
            <Button variant="outline" onClick={onClose}>
              {t('desktop.update.later')}
            </Button>
            <Button onClick={() => void restart()}>
              <Icon name="redo" className="size-4" />
              {t('desktop.update.restart')}
            </Button>
          </>
        ) : (
          <>
            <Button variant="outline" onClick={onClose} disabled={installing}>
              {t('desktop.update.later')}
            </Button>
            <Button onClick={() => void start()} loading={installing} disabled={installing}>
              <Icon name="download" className="size-4" />
              {t('desktop.update.install')}
            </Button>
          </>
        )
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          {t('desktop.update.fromTo', { current: update?.version ?? '', next: update?.newVersion ?? '' })}
        </p>

        {update?.notes ? (
          <div className="max-h-64 overflow-y-auto rounded-xl border border-border/70 bg-muted/40 px-4 py-3">
            <p className="whitespace-pre-wrap text-sm leading-6">{update.notes}</p>
          </div>
        ) : null}

        {installing || ready ? (
          <div className="space-y-2">
            <div className="h-1.5 overflow-hidden rounded-full bg-secondary">
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-200"
                style={{ width: `${ready ? 100 : percent}%` }}
              />
            </div>
            <p className="text-xs text-muted-foreground" aria-live="polite">
              {ready
                ? t('desktop.update.ready')
                : t('desktop.update.downloading', {
                    percent,
                    done: formatBytes(progress.downloaded),
                    total: formatBytes(progress.total),
                  })}
            </p>
          </div>
        ) : null}

        {failed ? (
          <p role="alert" className="text-sm text-destructive">
            {failed}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

/** 自动检查：每个应用运行期间只查一次，且只在桌面端。 */
export function useAutoUpdateCheck() {
  const [update, setUpdate] = useState<UpdateCheck | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!isDesktop()) return undefined;
    let cancelled = false;
    // 启动后等一会儿再查：先让首屏与编辑器就位，别和启动时的接口抢带宽。
    const timer = setTimeout(async () => {
      try {
        const found = await checkForUpdates();
        if (cancelled || !found.available) return;
        setUpdate(found);
        setOpen(true);
      } catch {
        // 离线或接口不可用：静默跳过，用户可以在个人设置里手动检查。
      }
    }, 3000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  return { update, open, close: () => setOpen(false) };
}
