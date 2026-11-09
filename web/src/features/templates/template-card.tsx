/**
 * 模板卡片外壳。
 *
 * 选择对话框与「模板」页两处都用它，因为两处的差异只在**预览来源**
 * （内置模板实时渲染 / 用户模板缩略图）与**有没有行内操作**（改名、删除）。
 * 复制一份卡片样式迟早会在圆角、悬停色或禁用态上分叉。
 */

import type { ReactNode } from 'react';
import { Icon } from '@/components/ui/icon';
import { cn } from '@/lib/utils';

export interface TemplateCardProps {
  title: string;
  /** 结构名，显示在标题右侧的小字。 */
  structure: string;
  /** 预览区内容。高度由调用方给，卡片不猜。 */
  preview: ReactNode;
  disabled?: boolean;
  onPick: () => void;
  /** 行内操作（改名 / 删除）。有它就说明这是「我的模板」。 */
  actions?: ReactNode;
}

export function TemplateCard({ title, structure, preview, disabled, onPick, actions }: TemplateCardProps) {
  return (
    <div className="rounded-2xl border border-border/70 p-3 transition-colors hover:border-primary/60 hover:bg-muted/40">
      {/*
        预览区与标题都是按钮的一部分，但操作区不能是：把「删除」嵌在按钮里
        会变成按钮套按钮（无效 HTML，读屏器也会念错）。所以卡片是一个
        div，主体部分自己是一个铺满的按钮。
      */}
      <button type="button" disabled={disabled} onClick={onPick} className="block w-full text-left disabled:opacity-60">
        <div className="overflow-hidden rounded-xl bg-muted/40">{preview}</div>
        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="truncate text-sm font-medium">{title}</span>
          <span className="shrink-0 text-[11px] text-muted-foreground">{structure}</span>
        </div>
      </button>
      {actions ? <div className="mt-1 flex items-center justify-end gap-1">{actions}</div> : null}
    </div>
  );
}

/** 没有缩略图时的占位。 */
export function TemplatePlaceholder({ height }: { height: number }) {
  return (
    <div className="grid place-items-center" style={{ height }}>
      <Icon name="waypoints" className={cn('size-6 text-muted-foreground/50')} />
    </div>
  );
}
