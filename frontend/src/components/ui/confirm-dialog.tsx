/**
 * 二次确认对话框。
 *
 * 复用 `Modal`，只补上「确认按钮可以有危险色、可以显示进行中」这两件事。
 * 单独抽出来是因为回收站里「彻底删除」和「清空」两处都要它，而两份实现
 * 迟早在文案或禁用逻辑上分叉。
 */

import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel: string;
  cancelLabel: string;
  /** 危险操作用红色按钮，且默认焦点**不**落在确认上。 */
  destructive?: boolean;
  pending?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel,
  destructive = false,
  pending = false,
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  return (
    <Modal
      open={open}
      title={title}
      description={description}
      onClose={onClose}
      footer={
        <>
          {/*
            取消排在前面、确认在后面，并且危险操作**不**把焦点放在确认上：
            连按两下回车就把东西删掉，是二次确认最容易失效的方式。
          */}
          <Button variant="outline" onClick={onClose} disabled={pending}>
            {cancelLabel}
          </Button>
          <Button variant={destructive ? 'destructive' : 'default'} onClick={onConfirm} disabled={pending}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {/* 正文已经写在 description 里，这里留空保持 Modal 的间距稳定。 */}
      <div />
    </Modal>
  );
}
