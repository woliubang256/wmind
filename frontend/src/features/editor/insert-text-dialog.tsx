import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Textarea, TextField, Field } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import type { ContentPatch } from '@/editor/commands/content';
import type { Topic, WmindDocument } from '@/editor/model/types';
import { safeTopicHref } from '@/editor/model/topic-content';
import { flatten } from '@/editor/model/traverse';
import type { InsertAction } from './insert-actions';

export function InsertTextDialog({ action, topics, doc, onSave, onClose }: { action: InsertAction; topics: Topic[]; doc: WmindDocument; onSave(patch: ContentPatch): void; onClose(): void }) {
  const { t } = useTranslation(); const first = topics[0]!;
  const [value, setValue] = useState(action === 'note' ? first.notes.plain : action === 'label' ? first.labels.join('\n') : action === 'web' ? first.href : action === 'topic' ? first.href.replace(/^xmind:#/, '') : '');
  const [done, setDone] = useState(first.content?.todo ?? false);
  const [task, setTask] = useState(first.content?.task ?? { progress: 0, priority: 0, assignee: '', start: '', due: '' });
  const [error, setError] = useState('');
  const submit = (patch: ContentPatch) => { try { onSave(patch); } catch (error) { const message = t(`editor.content.error.${error instanceof Error ? error.message : 'save'}`); setError(message.startsWith('editor.') ? t('editor.content.error.save') : message); } };
  const save = () => {
    if (action === 'note') submit({ notes: { plain: value, html: '' } });
    else if (action === 'label') submit({ labels: value.split(/[\n,，]/) });
    else if (action === 'todo') submit({ content: { todo: done } });
    else if (action === 'task') { if (task.start && task.due && task.start > task.due) { setError(t('editor.content.error.dates')); return; } submit({ content: { task } }); }
    else if (action === 'web') { if (!safeTopicHref(value.trim()) || value.startsWith('xmind:')) { setError(t('editor.content.error.invalid-link')); return; } submit({ href: value.trim(), content: { localLink: undefined } }); }
    else if (action === 'topic') { if (!flatten(doc).some((topic) => topic.id === value && !topics.some((source) => source.id === value))) { setError(t('editor.content.error.target')); return; } submit({ href: `xmind:#${value}`, content: { localLink: undefined } }); }
  };
  const remove = () => submit(action === 'note' ? { notes: { plain: '', html: '' } } : action === 'label' ? { labels: [] } : action === 'todo' ? { content: { todo: undefined } } : action === 'task' ? { content: { task: undefined } } : { href: '', content: { localLink: undefined } });
  return <Modal open title={t(`editor.content.${action}`)} onClose={onClose} description={topics.length > 1 ? t('editor.content.batch', { count: topics.length }) : first.title}
    footer={<><Button variant="ghost" onClick={remove}>{t('editor.content.remove')}</Button><Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button><Button onClick={save}>{t('common.save')}</Button></>}>
    <div className="space-y-4">
      {action === 'note' || action === 'label' ? <Field label={t(`editor.content.${action}`)} hint={action === 'label' ? t('editor.content.labelsHint') : undefined} htmlFor="insert-text"><Textarea id="insert-text" autoFocus rows={action === 'note' ? 10 : 5} value={value} onChange={(event) => setValue(event.target.value)} /></Field> : null}
      {action === 'todo' ? <label className="flex items-center gap-3"><input type="checkbox" checked={done} onChange={(event) => setDone(event.target.checked)} />{t('editor.content.done')}</label> : null}
      {action === 'web' ? <TextField autoFocus label={t('editor.content.url')} value={value} placeholder="https://example.com" onChange={(event) => setValue(event.target.value)} /> : null}
      {action === 'topic' ? <Field label={t('editor.content.target')}><Select value={value} onChange={setValue} aria-label={t('editor.content.target')} options={flatten(doc).filter((item) => !topics.some((source) => source.id === item.id)).map((item) => ({ value: item.id, label: `${'　'.repeat(Math.min(4, item.depth))}${item.title || t('editor.a11y.untitled')}` }))} /></Field> : null}
      {action === 'task' ? <>
        <TextField label={t('editor.content.assignee')} value={task.assignee} onChange={(event) => setTask({ ...task, assignee: event.target.value })} />
        <div className="grid grid-cols-2 gap-4"><TextField label={t('editor.content.progress')} type="number" min={0} max={100} value={task.progress} onChange={(event) => setTask({ ...task, progress: Math.min(100, Math.max(0, Number(event.target.value))) })} />
          <Field label={t('editor.content.priority')}><Select aria-label={t('editor.content.priority')} value={String(task.priority)} onChange={(value) => setTask({ ...task, priority: Number(value) })} options={[0, 1, 2, 3, 4, 5].map((value) => ({ value: String(value), label: value ? `P${value}` : t('editor.content.none') }))} /></Field></div>
        <div className="grid grid-cols-2 gap-4"><TextField label={t('editor.content.start')} type="date" value={task.start} onChange={(event) => setTask({ ...task, start: event.target.value })} /><TextField label={t('editor.content.due')} type="date" value={task.due} onChange={(event) => setTask({ ...task, due: event.target.value })} /></div>
      </> : null}
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    </div>
  </Modal>;
}
