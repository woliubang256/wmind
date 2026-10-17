import { useEffect, useRef, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Button } from './button';
import { Icon } from './icon';

interface ModalProps {
  open: boolean;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  /** 关闭回调。`dismissible=false` 时不响应遮罩点击与 Esc（用于一次性密码展示）。 */
  onClose: () => void;
  dismissible?: boolean;
  size?: 'md' | 'lg';
}

/**
 * 轻量对话框。
 *
 * 用原生 `<dialog>` 而不是自己造遮罩：焦点陷阱、Esc 关闭、`::backdrop`
 * 都由浏览器负责，这些正是手写对话框最容易出错的地方。
 */
export function Modal({ open, title, description, children, footer, onClose, dismissible = true, size = 'md' }: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  // Esc 在原生 dialog 上会触发 cancel 事件。不可关闭的对话框必须拦掉它，
  // 否则「一次性密码」会被 Esc 顺手关掉，用户再也看不到密码。
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || dismissible) return;
    const blockCancel = (event: Event) => event.preventDefault();
    dialog.addEventListener('cancel', blockCancel);
    return () => dialog.removeEventListener('cancel', blockCancel);
  }, [dismissible]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(event) => {
        // 点击遮罩时 target 是 dialog 本身（内容在子元素里）。
        if (dismissible && event.target === ref.current) onClose();
      }}
      className={cn(
        // m-auto 是必需的：原生 <dialog> 靠 UA 样式里的 margin:auto 居中，
        // 而 Tailwind 的 preflight 把所有元素的 margin 清零——不写这一条，
        // 对话框会贴在视口左上角。
        'm-auto max-h-[90vh] w-[min(92vw,32rem)] rounded-2xl border border-border bg-card p-0 text-card-foreground',
        'backdrop:bg-black/40 backdrop:backdrop-blur-sm',
        size === 'lg' && 'w-[min(94vw,44rem)]',
      )}
    >
      <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
        <div className="min-w-0">
          <h2 className="text-base font-semibold">{title}</h2>
          {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
        </div>
        {dismissible ? (
          <Button variant="ghost" size="icon" aria-label="关闭" onClick={onClose} className="-mr-1 -mt-1 shrink-0">
            <Icon name="x" className="size-4" />
          </Button>
        ) : null}
      </div>
      <div className="max-h-[70vh] overflow-y-auto px-5 py-4">{children}</div>
      {footer ? <div className="flex justify-end gap-2 border-t border-border px-5 py-4">{footer}</div> : null}
    </dialog>
  );
}
