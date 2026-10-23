import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Point } from '../layout/types';
import type { Viewport } from './viewer-types';

/** 与主题编辑相同的 HTML 覆盖层，避免 foreignObject 的输入法差异。 */
export function RelationshipEditor({ title, label, viewport, onFinish }: {
  title: string;
  label: Point;
  viewport: Viewport;
  onFinish(value: string | null, restoreFocus: boolean): void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState(title);
  const ref = useRef<HTMLInputElement>(null);
  const settled = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (commit: boolean, restoreFocus = false) => {
    if (settled.current) return;
    settled.current = true;
    onFinish(commit ? value : null, restoreFocus);
  };
  return (
    <input
      ref={ref} value={value} aria-label={t('editor.annotation.relationshipTitle')}
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === 'Enter' || event.key === 'Escape') {
          event.preventDefault();
          finish(event.key === 'Enter', true);
        }
      }}
      className="absolute z-10 h-9 rounded-md border-2 border-primary bg-background px-2 text-center text-sm text-foreground outline-none"
      style={{ left: viewport.x + label.x * viewport.zoom, top: viewport.y + (label.y - 12) * viewport.zoom,
        width: Math.min(480, Math.max(180, value.length * 10)) * Math.min(1.5, Math.max(0.8, viewport.zoom)), transform: 'translate(-50%, -50%)' }}
    />
  );
}
