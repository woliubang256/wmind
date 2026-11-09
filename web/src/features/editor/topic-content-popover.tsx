import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { placeMenu } from '@/components/ui/select';
import type { Topic } from '@/editor/model/types';
import { safeTopicHref } from '@/editor/model/topic-content';
import { topicNoteText } from './topic-note-text';
import type { InsertAction } from './insert-actions';

export function TopicContentPopover({ topic, anchor, readOnly, linkTitle, onClose, onEdit, onOpenLink }: {
  topic: Topic; anchor: Element; readOnly: boolean; linkTitle: string;
  onClose: (restoreFocus?: boolean) => void; onEdit: (action: InsertAction) => void; onOpenLink: () => void;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState({ top: 0, left: 0, width: 320, maxHeight: 360 });
  const hasNote = Boolean(topic.notes.plain || topic.notes.html);
  const hasLink = Boolean(topic.content?.localLink || safeTopicHref(topic.href));
  const note = useMemo(() => topicNoteText(topic.notes), [topic.notes]);
  useLayoutEffect(() => {
    if (!anchor.isConnected || !ref.current) { onClose(false); return; }
    const rect = anchor.getBoundingClientRect();
    const { top, left, width, maxHeight } = placeMenu(rect, ref.current.scrollHeight, { width: window.innerWidth, height: window.innerHeight }, { minWidth: 320, maxHeight: 360, gap: 8 });
    setPlacement({ top, left, width, maxHeight });
    ref.current.focus({ preventScroll: true });
  }, [anchor, topic, readOnly, onClose]);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node) && !anchor.contains(event.target as Node)) onClose(false);
    };
    const close = () => onClose(false);
    const scroll = (event: Event) => { if (!ref.current?.contains(event.target as Node)) onClose(false); };
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', scroll, true);
    return () => { document.removeEventListener('pointerdown', outside, true); window.removeEventListener('resize', close); window.removeEventListener('scroll', scroll, true); };
  }, [anchor, onClose]);
  return createPortal(<div ref={ref} role="dialog" aria-label={t('editor.content.title')} tabIndex={-1}
    className="fixed z-50 overflow-auto rounded-lg border bg-popover p-3 text-popover-foreground shadow-md outline-none"
    style={placement} onKeyDown={(event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
      if (event.key === 'Tab') {
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
        const first = buttons[0]; const last = buttons[buttons.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }}>
    <div className="mb-2 flex items-center justify-between gap-3 border-b pb-2">
      <span className="truncate text-xs font-medium">{topic.title}</span>
      <Button variant="ghost" size="icon" className="size-6 shrink-0" aria-label={t('common.close')} onClick={() => onClose()}><Icon name="x" className="size-3.5" /></Button>
    </div>
    {hasNote ? <section className="space-y-2">
      <div className="flex items-center justify-between text-xs text-muted-foreground"><span className="flex items-center gap-1.5"><Icon name="note" className="size-3.5" />{t('editor.content.note')}</span>
        {!readOnly ? <Button variant="ghost" size="sm" className="h-6 px-1.5 text-xs" onClick={() => onEdit('note')}>{t('editor.content.editNote')}</Button> : null}
      </div><p className="max-h-44 overflow-auto whitespace-pre-wrap break-words text-sm leading-relaxed">{note}</p>
    </section> : null}
    {hasLink ? <section className={hasNote ? 'mt-3 space-y-2 border-t pt-3' : 'space-y-2'}>
      <div className="flex items-center justify-between text-xs text-muted-foreground"><span className="flex items-center gap-1.5"><Icon name="link" className="size-3.5" />{t('editor.content.link')}</span>
        {!readOnly ? <Button variant="ghost" size="sm" className="h-6 px-1.5 text-xs" onClick={() => onEdit(topic.content?.localLink?.kind === 'folder' ? 'folder' : topic.content?.localLink ? 'file' : topic.href.startsWith('xmind:#') ? 'topic' : 'web')}>{t('editor.content.editLink')}</Button> : null}
      </div><p className="break-words text-xs text-muted-foreground">{linkTitle}</p>
      <Button variant="outline" size="sm" className="w-full text-xs" onClick={onOpenLink}><Icon name="arrow-right" className="mr-1.5 size-3.5" />{t('editor.content.openLink')}</Button>
    </section> : null}
  </div>, document.body);
}
