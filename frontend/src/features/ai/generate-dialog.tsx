import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Textarea } from '@/components/ui/input';
import { LoadingState } from '@/components/ui/loading-state';
import { Modal } from '@/components/ui/modal';
import { mapKeys } from '@/features/maps/queries';
import { mapApi } from '@/lib/api/maps';
import { ApiError } from '@/lib/api/errors';
import { formatBytes } from '@/lib/format';
import type { WmindDocument } from '@/editor/model/types';
import { aiApi } from './api';
import { extractAttachments } from './attachments';
import { documentFromAI } from './document';
import { AI_ACCEPT, AIFileError, AI_LIMITS, textLength, validateFiles } from './limits';

export function AIGenerateDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const formId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const running = useRef<AbortController | null>(null);
  const saving = useRef(false);
  const [prompt, setPrompt] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [generated, setGenerated] = useState<WmindDocument | null>(null);
  const [phase, setPhase] = useState<'idle' | 'extracting' | 'generating' | 'saving'>('idle');
  const [currentFile, setCurrentFile] = useState('');
  const [error, setError] = useState('');
  const busy = phase !== 'idle';

  useEffect(() => () => { running.current?.abort(); }, []);

  const close = () => {
    if (saving.current) return;
    running.current?.abort();
    onClose();
  };
  const resetResult = () => { setGenerated(null); setError(''); };
  const message = (error: unknown) => {
    if (error instanceof AIFileError) {
      const detail = t(`ai.fileError.${error.code}`);
      return error.fileName ? t('ai.fileFailed', { name: error.fileName, reason: detail }) : detail;
    }
    return error instanceof Error ? error.message : t('ai.failed');
  };
  const addFiles = (incoming: File[]) => {
    if (running.current) return;
    const next = [...files];
    for (const file of incoming) {
      if (!next.some((item) => item.name === file.name && item.size === file.size && item.lastModified === file.lastModified)) next.push(file);
    }
    try {
      validateFiles(next);
      setFiles(next);
      resetResult();
    } catch (error) { setError(message(error)); }
  };

  const generate = async (event: FormEvent) => {
    event.preventDefault();
    if (running.current || (!prompt.trim() && files.length === 0)) return;
    const controller = new AbortController();
    running.current = controller;
    setError('');
    try {
      let document = generated;
      if (!document) {
        setPhase('extracting');
        const sources = await extractAttachments(files, prompt.trim(), controller.signal, setCurrentFile);
        controller.signal.throwIfAborted();
        setPhase('generating');
        const root = await aiApi.generate({ prompt: prompt.trim(), sources }, controller.signal);
        controller.signal.throwIfAborted();
        try { document = documentFromAI(root); }
        catch { throw new Error(t('errors.AI_OUTPUT_INVALID')); }
        setGenerated(document);
      }
      controller.signal.throwIfAborted();
      saving.current = true;
      setPhase('saving');
      const created = await mapApi.create({ title: document.title, document });
      void queryClient.invalidateQueries({ queryKey: mapKeys.lists() });
      if (controller.signal.aborted) return;
      onClose();
      navigate(`/maps/${created.uid}`);
    } catch (error) {
      if (controller.signal.aborted) return;
      setError(message(error));
      if (error instanceof ApiError && error.code === 'AI_DISABLED') {
        void queryClient.invalidateQueries({ queryKey: ['site', 'config'] });
      }
    } finally {
      saving.current = false;
      if (!controller.signal.aborted) {
        running.current = null;
        setPhase('idle');
      }
    }
  };

  return <Modal open title={t('ai.title')} onClose={close} dismissible={phase !== 'saving'} size="lg"
    footer={<>
      <Button variant="outline" disabled={phase === 'saving'} onClick={close}>{t('common.cancel')}</Button>
      <Button form={formId} type="submit" loading={busy} disabled={busy || (!prompt.trim() && files.length === 0) || textLength(prompt) > AI_LIMITS.textRunes}>
        {!busy && <Icon name={generated ? 'save' : 'sparkles'} className="size-4" />}
        {phase === 'saving' ? t('common.saving') : phase === 'generating' ? t('ai.generating') : phase === 'extracting' ? t('ai.preparing') : generated ? t('ai.retrySave') : t('ai.generate')}
      </Button>
    </>}>
    <form id={formId} onSubmit={(event) => { void generate(event); }} className="space-y-4" aria-busy={busy}
      onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.stopPropagation(); } }}
      onDrop={(event) => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.stopPropagation(); if (!busy) addFiles(Array.from(event.dataTransfer.files)); } }}>
      <Textarea aria-label={t('ai.prompt')} placeholder={t('ai.placeholder')} rows={7} autoFocus value={prompt} disabled={busy}
        onChange={(event) => { setPrompt(event.target.value); resetResult(); }} className="min-h-44 text-sm leading-6" />
      {files.length > 0 && <ul className="space-y-2" aria-label={t('ai.attachments')}>
        {files.map((file, index) => <li key={`${file.name}-${index}`} className="flex min-w-0 items-center gap-3 rounded-lg bg-muted/55 py-1.5 pl-3 pr-1">
          <Icon name={/\.(png|jpe?g|webp|gif)$/i.test(file.name) ? 'image' : 'file'} className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-sm" title={file.name}>{file.name}</span>
          <span className="shrink-0 text-xs text-muted-foreground">{formatBytes(file.size)}</span>
          <Button variant="ghost" size="icon" className="size-8 shrink-0" disabled={busy} aria-label={t('ai.removeFile', { name: file.name })}
            onClick={() => { setFiles((previous) => previous.filter((_, at) => at !== index)); resetResult(); }}><Icon name="x" className="size-3.5" /></Button>
        </li>)}
      </ul>}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <input ref={fileInput} type="file" accept={AI_ACCEPT} multiple className="hidden" aria-label={t('ai.upload')}
          onChange={(event) => { addFiles(Array.from(event.target.files ?? [])); event.target.value = ''; }} />
        <Button variant="outline" size="sm" disabled={busy || files.length >= AI_LIMITS.files} onClick={() => fileInput.current?.click()}><Icon name="paperclip" className="size-4" />{t('ai.upload')}</Button>
        <span className="text-xs text-muted-foreground">{t('ai.formats')}</span>
      </div>
      {phase === 'extracting' && currentFile && <LoadingState inline label={t('ai.extracting', { name: currentFile })} className="text-xs" />}
      {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
      <p className="text-xs leading-5 text-muted-foreground">{t('ai.providerNotice')}</p>
    </form>
  </Modal>;
}
