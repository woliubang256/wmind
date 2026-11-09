import { useRef, useState, type InputHTMLAttributes } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { LoadingImage } from '@/components/ui/loading-image';
import { Modal } from '@/components/ui/modal';
import { Field } from '@/components/ui/input';
import { fileApi } from '@/lib/api/files';
import type { ContentPatch } from '@/editor/commands/content';
import type { Topic } from '@/editor/model/types';
import { embedFiles, downloadEmbedded } from './insert-files';
import type { InsertAction } from './insert-actions';

export function InsertFileDialog({ action, topics, onSave, onClose }: { action: InsertAction; topics: Topic[]; onSave(patch: ContentPatch): void; onClose(): void }) {
  const { t } = useTranslation(); const first = topics[0]!; const input = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]); const [attachments, setAttachments] = useState(first.content?.attachments ?? []);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const image = action === 'image', folder = action === 'folder';
  const fail = (error: unknown) => {
    const key = error && typeof error === 'object' && 'code' in error ? String(error.code).toLowerCase().replaceAll('_', '-') : error instanceof Error ? error.message : 'save';
    const translated = t(`editor.content.error.${key}`); setError(translated.startsWith('editor.') ? t('editor.content.error.save') : translated);
  };
  const save = async () => {
    setBusy(true); setError('');
    try {
      if (image) {
        if (!files.length) { if (first.image) onSave({ image: first.image }); else throw new Error('choose-file'); }
        else {
          if (files[0].size > 8 * 1024 * 1024) throw new Error('image-too-large');
          const uploaded = await fileApi.upload({ bytes: new Uint8Array(await files[0].arrayBuffer()), mime: files[0].type, fileName: files[0].name });
          onSave({ image: { src: uploaded.url, width: uploaded.width, height: uploaded.height } });
        }
      } else {
        const additions = await embedFiles(files, folder);
        if (action === 'attachment') onSave({ content: { attachments: [...attachments, ...additions] } });
        else { const link = additions[0] ?? first.content?.localLink; if (!link) throw new Error('choose-file'); onSave({ href: '', content: { localLink: link } }); }
      }
    } catch (error) { fail(error); } finally { setBusy(false); }
  };
  const remove = () => { try { onSave(image ? { image: null } : action === 'attachment' ? { content: { attachments: undefined } } : { href: '', content: { localLink: undefined } }); } catch (error) { fail(error); } };
  const attrs = folder ? { webkitdirectory: '', directory: '' } as InputHTMLAttributes<HTMLInputElement> : {};
  return <Modal open title={t(`editor.content.${action}`)} description={image ? t('editor.content.imageLimit') : t('editor.content.fileLimit')} onClose={onClose} dismissible={!busy}
    footer={<><Button variant="ghost" disabled={busy} onClick={remove}>{t('editor.content.remove')}</Button><Button variant="outline" disabled={busy} onClick={onClose}>{t('common.cancel')}</Button><Button loading={busy} onClick={() => void save()}>{t(busy ? 'editor.content.saving' : 'common.save')}</Button></>}>
    <div className="space-y-4">
      {image && first.image ? <LoadingImage src={first.image.src} alt={first.title} containerClassName="min-h-16" className="max-h-48 max-w-full rounded-lg object-contain" /> : null}
      {!image && first.content?.localLink && action !== 'attachment' ? <button className="text-sm text-primary underline" onClick={() => downloadEmbedded(first.content!.localLink!)}>{first.content.localLink.name}</button> : null}
      <Field label={t('editor.content.chooseFile')} htmlFor="insert-file"><input ref={input} id="insert-file" type="file" className="block w-full rounded-lg border border-input p-3 text-sm file:mr-3 file:rounded file:border-0 file:bg-muted file:px-3 file:py-2" disabled={busy} accept={image ? 'image/png,image/jpeg,image/gif,image/webp' : undefined} multiple={action === 'attachment' || folder} {...attrs}
        onChange={(event) => { setFiles([...event.target.files ?? []]); setError(''); }} /></Field>
      {files.length ? <p className="break-words text-sm">{files.map((file) => file.name).join('、')}</p> : null}
      {action === 'attachment' ? attachments.map((file) => <div key={file.id} className="flex items-center justify-between gap-3 rounded-lg border border-border p-2"><button className="min-w-0 truncate text-sm text-primary underline" onClick={() => downloadEmbedded(file)}>{file.name}</button><Button size="sm" variant="ghost" aria-label={t('editor.content.removeFile', { name: file.name })} onClick={() => setAttachments(attachments.filter((item) => item.id !== file.id))}>{t('editor.content.remove')}</Button></div>) : null}
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    </div>
  </Modal>;
}
