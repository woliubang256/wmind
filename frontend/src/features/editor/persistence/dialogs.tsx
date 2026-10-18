/**
 * 持久化相关的两个对话框：版本冲突、离开确认。
 *
 * 两者都做成「不可 Esc 关闭」——它们代表一个必须表态的状态。冲突对话框被
 * 顺手关掉的话，自动保存仍然是暂停的，用户会看到「已保存」以外的状态却
 * 不知道该怎么继续；离开确认被关掉则等于默认「留下」，与用户的意图相反。
 */

import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Modal } from '@/components/ui/modal';
import type { AutosaveConflict } from './autosave';

export interface ConflictDialogProps {
  open: boolean;
  conflict: AutosaveConflict | null;
  /** 本地版本号，用于文案里的「你的 v3 / 服务器 v5」。 */
  localVersion: number;
  busy: boolean;
  onOverwrite: () => void;
  onReload: () => void;
  onSaveAsCopy: () => void;
}

export function ConflictDialog({
  open,
  conflict,
  localVersion,
  busy,
  onOverwrite,
  onReload,
  onSaveAsCopy,
}: ConflictDialogProps) {
  const { t } = useTranslation();
  return (
    <Modal
      open={open}
      dismissible={false}
      title={t('editor.conflict.title')}
      description={t('editor.conflict.description', {
        mine: localVersion,
        theirs: conflict?.version ?? 0,
      })}
      onClose={() => undefined}
      footer={
        <div className="flex flex-col gap-2">
          <Button onClick={onOverwrite} disabled={busy}>
            <Icon name="check" className="size-4" />
            {t('editor.conflict.keepMine')}
          </Button>
          <div className="grid grid-cols-2 gap-2">
            <Button variant="outline" onClick={onReload} disabled={busy}>
              {t('editor.conflict.discard')}
            </Button>
            <Button variant="outline" onClick={onSaveAsCopy} disabled={busy}>
              {t('editor.conflict.saveAsCopy')}
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-3 text-sm text-muted-foreground">
        <p>{t('editor.conflict.keepMineHint')}</p>
        <p>{t('editor.conflict.discardHint')}</p>
        <p>{t('editor.conflict.saveAsCopyHint')}</p>
        {conflict?.updatedAt ? (
          <p className="flex items-center gap-1.5 text-xs">
            <Icon name="clock" className="size-3.5" />
            {t('editor.conflict.serverUpdatedAt', {
              time: new Date(conflict.updatedAt).toLocaleString(),
            })}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

export interface LeaveDialogProps {
  open: boolean;
  onStay: () => void;
  onLeave: () => void;
}

export function LeaveDialog({ open, onStay, onLeave }: LeaveDialogProps) {
  const { t } = useTranslation();
  return (
    <Modal
      open={open}
      dismissible={false}
      title={t('editor.leave.title')}
      description={t('editor.leave.description')}
      onClose={() => undefined}
      footer={
        <div className="grid grid-cols-2 gap-2">
          <Button variant="outline" onClick={onStay}>
            {t('editor.leave.stay')}
          </Button>
          <Button onClick={onLeave}>{t('editor.leave.leave')}</Button>
        </div>
      }
    >
      <p className="text-sm text-muted-foreground">{t('editor.leave.hint')}</p>
    </Modal>
  );
}
