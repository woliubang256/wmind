import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Field, Textarea } from '@/components/ui/input';
import type { ContentPatch } from '@/editor/commands/content';
import type { Topic } from '@/editor/model/types';
import { artwork, STICKERS, ILLUSTRATIONS } from '@/editor/model/insert-artwork';
import type { InsertAction } from './insert-actions';

export function InsertVisualDialog({ action, topics, onSave, onClose }: { action: InsertAction; topics: Topic[]; onSave(patch: ContentPatch): void; onClose(): void }) {
  const { t } = useTranslation(); const first = topics[0]!; const equation = action === 'equation';
  const [value, setValue] = useState(equation ? first.content?.equation?.latex ?? 'E = mc^2' : action === 'sticker' ? first.content?.sticker ?? '' : first.content?.illustration ?? '');
  const [preview, setPreview] = useState(first.content?.equation); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!equation) return;
    let cancelled = false; setBusy(true);
    const timer = setTimeout(() => { void import('./insert-equation').then(({ renderEquation }) => {
      if (cancelled) return;
      try { setPreview(renderEquation(value)); setError(''); } catch { setPreview(undefined); setError(t('editor.content.error.equation')); }
    }).catch(() => { if (!cancelled) setError(t('editor.content.error.equation')); }).finally(() => { if (!cancelled) setBusy(false); }); }, 200);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [equation, value, t]);
  const save = (remove = false) => {
    if (!remove && (equation ? !preview || busy : !value)) return;
    try { onSave({ content: equation ? { equation: remove ? undefined : preview } : action === 'sticker' ? { sticker: remove ? undefined : value } : { illustration: remove ? undefined : value } }); }
    catch (error) { const key = error instanceof Error ? error.message : 'save'; const message = t(`editor.content.error.${key}`); setError(message.startsWith('editor.') ? t('editor.content.error.save') : message); }
  };
  const ids = action === 'sticker' ? STICKERS : ILLUSTRATIONS;
  return <Modal open title={t(`editor.content.${action}`)} onClose={onClose} size={equation ? 'lg' : 'md'} description={topics.length > 1 ? t('editor.content.batch', { count: topics.length }) : first.title}
    footer={<><Button variant="ghost" onClick={() => save(true)}>{t('editor.content.remove')}</Button><Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button><Button disabled={equation ? busy || !preview : !value} onClick={() => save()}>{t('common.save')}</Button></>}>
    {equation ? <div className="space-y-4"><Field label="LaTeX" htmlFor="insert-equation" hint={t('editor.content.equationHint')}><Textarea id="insert-equation" autoFocus value={value} rows={4} maxLength={2000} onChange={(event) => { setValue(event.target.value); setPreview(undefined); }} /></Field>
      <div aria-label={t('editor.content.preview')} className="flex min-h-28 items-center justify-center overflow-auto rounded-xl border border-border bg-white p-5">{preview ? <img src={preview.src} alt={value} className="max-h-48 max-w-full" /> : <span className="text-sm text-neutral-500">{t(busy ? 'editor.content.rendering' : 'editor.content.preview')}</span>}</div></div> :
      <div role="group" aria-label={t(`editor.content.${action}`)} className={action === 'sticker' ? 'grid grid-cols-4 gap-3' : 'grid grid-cols-2 gap-3'}>{ids.map((id) => <button key={id} type="button" aria-label={t(`editor.content.art.${id}`)} aria-pressed={value === id}
        className="flex flex-col items-center gap-2 rounded-xl border border-border p-3 text-xs hover:bg-accent aria-pressed:border-primary aria-pressed:ring-2 aria-pressed:ring-primary/20"
        onClick={() => setValue(id)}><img src={artwork(action as 'sticker' | 'illustration', id)!.src} alt="" className={action === 'sticker' ? 'size-12' : 'h-20 w-full object-contain'} />{t(`editor.content.art.${id}`)}</button>)}</div>}
    {error ? <p role="alert" className="mt-3 text-sm text-destructive">{error}</p> : null}
  </Modal>;
}
