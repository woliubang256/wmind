/**
 * 导入对话框。
 *
 * 三个刻意的决定：
 *
 * 1. **解析前先等一个宏任务**。`importRegistry.run()` 是同步的，50MB 的 zip
 *    在主线程上要跑几百毫秒到一秒多。不先让出一帧，「正在解析」这行字根本
 *    画不出来，用户看到的是对话框卡住。真正的解法是 worker（M6 再说）。
 * 2. **超过上限的文件不读进内存**。`file.size` 是免费的，先判再
 *    `arrayBuffer()`；否则一个 2GB 的文件会先把内存吃满再报错。
 * 3. **摘要里的每一项都来自最终文档**（`summarizeImport` 扫的是产出的
 *    文档，不是适配器的自述），所以「已还原：备注」是真的有备注。
 *
 * 图片上传放在「解析完成 → 显示摘要」之间，而不是等用户点「创建导图」：
 * 摘要要如实说明「12 张图片已上传」还是「3 张没传上去」，用户才能决定是否
 * 继续。等确认后再传，失败就只能事后弹个 toast，而导图已经建好了。
 */

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { TextareaField } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { fileApi } from '@/lib/api/files';
import { mapApi } from '@/lib/api/maps';
import { formatBytes } from '@/lib/format';
import { cn } from '@/lib/utils';
import { importAcceptAttribute } from '@/editor/import/builtins';
import { IMPORT_LIMITS } from '@/editor/import/limits';
import type { ImportResult } from '@/editor/import/types';
import { createImportBatch, prepareImportBatch, type ImportBatchSource, type ImportProgress, type PreparedImport } from './import-batch';
import {
  importErrorMessage,
  importWarningText,
  restoredLabels,
  summaryRows,
  unsupportedRows,
} from './import-present';

type Phase =
  | { kind: 'idle' }
  | ImportProgress
  | { kind: 'ready'; items: PreparedImport[] }
  | { kind: 'failed'; fileName: string; message: string };

type ImportSource = 'file' | 'text';
const IMPORT_SOURCES: ImportSource[] = ['file', 'text'];

export interface ImportDialogProps {
  open: boolean;
  onClose: () => void;
  /** 保留页面拖入的全部文件及顺序，消费后清空以免重开时重复导入。 */
  initialFiles?: readonly File[] | null;
  onFilesConsumed?: () => void;
}

export function ImportDialog({ open, onClose, initialFiles, onFilesConsumed }: ImportDialogProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const runId = useRef(0);
  const creatingRef = useRef(false);
  const [source, setSource] = useState<ImportSource>('file');
  const [text, setText] = useState('');
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [dragging, setDragging] = useState(false);
  const [creating, setCreating] = useState(false);

  // 关闭后复位。放在这里而不是 onClose 里：Esc、点遮罩、外部调用都会经过 open。
  useEffect(() => {
    if (!open) {
      setPhase({ kind: 'idle' });
      setDragging(false);
      setCreating(false);
      creatingRef.current = false;
      setSource('file');
      setText('');
    }
    // 读取文件和上传不能同步撤回；失效的任务不得回写已关闭或重新打开的界面。
    return () => { runId.current += 1; };
  }, [open]);

  const close = () => {
    if (creatingRef.current) return;
    runId.current += 1;
    onClose();
  };

  const busy = creating || phase.kind === 'parsing' || phase.kind === 'uploading';
  const selectSource = (value: ImportSource) => {
    if (busy || creatingRef.current || value === source) return;
    runId.current += 1;
    setSource(value);
    setPhase({ kind: 'idle' });
    setDragging(false);
  };
  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (busy) return;
    let next: number;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') next = (index + 1) % IMPORT_SOURCES.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = IMPORT_SOURCES.length - 1;
    else return;
    event.preventDefault();
    selectSource(IMPORT_SOURCES[next]!);
    tabRefs.current[next]?.focus();
  };

  const runImport = async (sources: readonly ImportBatchSource[]) => {
    if (creatingRef.current || sources.length === 0) return;
    const current = ++runId.current;
    const items = await prepareImportBatch(sources, {
      isCurrent: () => current === runId.current,
      upload: fileApi.upload,
      onProgress: setPhase,
    });
    if (!items || current !== runId.current) return;
    const first = items[0]!;
    if (items.length === 1 && !first.result) {
      setPhase({ kind: 'failed', fileName: first.fileName, message: importErrorMessage(first.error, t) });
    } else setPhase({ kind: 'ready', items });
  };

  const importFiles = (files: readonly File[]) => {
    setSource('file');
    void runImport(files.map((file) => ({ name: file.name, size: file.size, read: async () => new Uint8Array(await file.arrayBuffer()) })));
  };
  const importText = () => {
    if (text.trim() === '' || busy) return;
    const bytes = new TextEncoder().encode(text);
    void runImport([{ name: t('import.dialog.textFileName'), size: bytes.byteLength, read: async () => bytes }]);
  };

  useEffect(() => {
    if (!open || !initialFiles?.length) return;
    onFilesConsumed?.();
    importFiles(initialFiles);
    // Only a newly supplied batch should start parsing, not each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialFiles]);

  const pickFiles = (files: FileList | null) => {
    if (files?.length) importFiles(Array.from(files));
  };

  const confirm = async () => {
    if (phase.kind !== 'ready' || creatingRef.current) return;
    const current = runId.current;
    creatingRef.current = true;
    setCreating(true);
    try {
      const completed = await createImportBatch(phase.items, mapApi.create, () => current === runId.current, (index, item) => {
        setPhase((previous) => previous.kind === 'ready'
          ? { kind: 'ready', items: previous.items.map((entry, i) => i === index ? item : entry) } : previous);
      });
      if (!completed || current !== runId.current) return;
      setPhase({ kind: 'ready', items: completed });
      const last = completed.filter((item) => item.createdUid).at(-1);
      const failed = completed.filter((item) => !item.createdUid);
      if (!last) {
        toast.error(t('import.dialog.createFailed'));
        return;
      }
      if (failed.length > 0) toast.warning(t('import.dialog.batchFailed', { files: failed.map((item) => item.fileName).join('、') }), { duration: 10000 });
      creatingRef.current = false;
      close();
      navigate(`/maps/${last.createdUid}`);
    } finally {
      if (current === runId.current) {
        creatingRef.current = false;
        setCreating(false);
      }
    }
  };

  const readyCount = phase.kind === 'ready' ? phase.items.filter((item) => item.result && !item.createdUid).length : 0;

  const footer =
    phase.kind === 'ready' ? (
      <div className="grid grid-cols-2 gap-2">
        <Button variant="outline" onClick={close} disabled={creating}>
          {t('import.dialog.cancel')}
        </Button>
        {readyCount > 0 ? <Button onClick={() => void confirm()} disabled={creating}>
          <Icon name="check" className="size-4" />
          {creating ? t('import.dialog.creating') : t(phase.items.length > 1 ? 'import.dialog.createBatch' : 'import.dialog.create', { n: readyCount })}
        </Button> : <Button onClick={() => setPhase({ kind: 'idle' })} disabled={creating}>{t('import.dialog.retry')}</Button>}
      </div>
    ) : phase.kind === 'failed' ? (
      <div className="grid grid-cols-2 gap-2">
        <Button variant="outline" onClick={close}>
          {t('import.dialog.cancel')}
        </Button>
        <Button onClick={() => setPhase({ kind: 'idle' })}>{t(source === 'file' ? 'import.dialog.retry' : 'import.dialog.editText')}</Button>
      </div>
    ) : (
      <>
        <Button variant="outline" onClick={close}>{t('import.dialog.cancel')}</Button>
        {source === 'text' && phase.kind === 'idle' ? (
          <Button onClick={importText} disabled={text.trim() === ''}>{t('import.dialog.parse')}</Button>
        ) : null}
      </>
    );

  return (
    <Modal
      open={open}
      size="lg"
      title={phase.kind === 'ready' ? t('import.dialog.summaryTitle') : t('import.dialog.title')}
      description={phase.kind === 'ready' ? t('import.dialog.summaryDescription') : undefined}
      onClose={close}
      dismissible={!creating}
      footer={footer}
    >
      <div role="tablist" aria-label={t('import.dialog.source')} className="mb-4 flex gap-5 border-b border-border">
        {IMPORT_SOURCES.map((value, index) => (
          <button key={value} ref={(node) => { tabRefs.current[index] = node; }} type="button" role="tab"
            id={`${id}-tab-${value}`} aria-controls={`${id}-panel-${value}`} aria-selected={source === value}
            tabIndex={source === value ? 0 : -1} disabled={busy}
            onClick={() => selectSource(value)} onKeyDown={(event) => onTabKeyDown(event, index)}
            className={cn('border-b-2 px-1 pb-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-wait',
              source === value ? 'border-primary font-medium text-primary' : 'border-transparent text-muted-foreground hover:text-foreground')}>
            {t(value === 'file' ? 'import.dialog.fileTab' : 'import.dialog.textTab')}
          </button>
        ))}
      </div>
      {IMPORT_SOURCES.map((value) => (
        <div key={value} role="tabpanel" id={`${id}-panel-${value}`} aria-labelledby={`${id}-tab-${value}`}
          hidden={source !== value}>
          {source === value ? <>
            {phase.kind === 'idle' && source === 'text' ? (
              <TextareaField label={t('import.dialog.textLabel')} placeholder={t('import.dialog.textPlaceholder')}
                value={text} onChange={(event) => setText(event.target.value)} rows={10}
                className="text-sm" spellCheck={false} />
            ) : null}
            {phase.kind === 'idle' && source === 'file' ? (
              <div
                onDragOver={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setDragging(false);
                  pickFiles(event.dataTransfer.files);
                }}
              >
                <button
                  type="button"
                  onClick={() => inputRef.current?.click()}
                  className={`flex w-full flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed px-6 py-12 text-center transition-colors ${
                    dragging ? 'border-primary bg-primary/5' : 'border-border bg-card/40 hover:border-primary/50'
                  }`}
                >
                  <span className="grid size-12 place-items-center rounded-2xl bg-secondary text-secondary-foreground">
                    <Icon name="upload" className="size-5" />
                  </span>
                  <span className="mt-1 text-sm font-medium">{t('import.dialog.dropTitle')}</span>
                  <span className="text-xs text-muted-foreground">{t('import.dialog.dropHint')}</span>
                  <span className="mt-1 text-xs text-muted-foreground">
                    {t('import.dialog.formats', { limit: formatBytes(IMPORT_LIMITS.maxInputBytes) })}
                  </span>
                </button>
                <input
                  ref={inputRef}
                  type="file"
                  multiple
                  accept={importAcceptAttribute()}
                  className="hidden"
                  onChange={(event) => {
                    pickFiles(event.target.files);
                    // 清空 value：同一个文件连选两次也要能触发 change。
                    event.target.value = '';
                  }}
                />
              </div>
            ) : null}

            {phase.kind === 'parsing' ? (
              <div className="flex items-center gap-3 rounded-2xl border border-border bg-card/40 px-5 py-8">
                <span className="size-5 shrink-0 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{phase.fileName}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{t('import.dialog.parsing')}{phase.totalFiles > 1 ? ` ${phase.index}/${phase.totalFiles}` : ''}</p>
                </div>
              </div>
            ) : null}

            {phase.kind === 'uploading' ? (
              <div className="space-y-3 rounded-2xl border border-border bg-card/40 px-5 py-6">
                <div className="flex items-center gap-3">
                  <span className="size-5 shrink-0 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{phase.fileName}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t('import.dialog.uploading', { done: phase.done, total: phase.total })}{phase.totalFiles > 1 ? ` ${phase.index}/${phase.totalFiles}` : ''}
                    </p>
                  </div>
                </div>
                {/* 进度条用宽度百分比而不是 <progress>：与其余卡片同一套圆角与配色。 */}
                <div className="h-1.5 overflow-hidden rounded-full bg-secondary">
                  <div
                    className="h-full rounded-full bg-primary transition-[width] duration-200"
                    style={{ width: `${phase.total === 0 ? 0 : Math.round((phase.done / phase.total) * 100)}%` }}
                  />
                </div>
              </div>
            ) : null}

            {phase.kind === 'failed' ? (
              <div className="space-y-3">
                <div className="flex items-start gap-3 rounded-2xl border border-destructive/30 bg-destructive/5 px-4 py-3">
                  <Icon name="alert" className="mt-0.5 size-4 shrink-0 text-destructive" />
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{t('import.dialog.errorTitle')}</p>
                    <p className="mt-1 break-words text-sm text-muted-foreground">{phase.message}</p>
                  </div>
                </div>
                <p className="truncate text-xs text-muted-foreground">{phase.fileName}</p>
              </div>
            ) : null}

            {phase.kind === 'ready' ? (
              <div className="space-y-4">
                {phase.items.length > 1 ? <p className="text-sm text-muted-foreground">{t('import.dialog.batchReady', { n: phase.items.filter((item) => item.result).length, total: phase.items.length })}</p> : null}
                {phase.items.map((item, index) => item.result ? (
                  <div key={index}>
                    {phase.items.length === 1 ? <ImportSummary fileName={item.fileName} size={item.size} result={item.result} /> : (
                      <details className="rounded-xl border border-border p-4">
                        <summary className="cursor-pointer break-words text-sm font-medium">
                          {item.fileName}<span className="ml-2 text-xs font-normal text-muted-foreground">{item.createdUid ? t('import.dialog.created') : t('import.dialog.topicsValue', { n: item.result.summary.topics, depth: item.result.summary.maxDepth })}</span>
                        </summary>
                        <div className="mt-4"><ImportSummary fileName={item.fileName} size={item.size} result={item.result} /></div>
                      </details>
                    )}
                    {item.createError !== undefined ? <p role="alert" className="mt-2 text-sm text-destructive">{item.fileName} · {t('import.dialog.createFailed')}</p> : null}
                  </div>
                ) : (
                  <div key={index} role="alert" className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm">
                    <p className="break-words font-medium">{item.fileName}</p>
                    <p className="mt-1 break-words text-muted-foreground">{importErrorMessage(item.error, t)}</p>
                  </div>
                ))}
              </div>
            ) : null}
          </> : null}
        </div>
      ))}
    </Modal>
  );
}

function ImportSummary({ fileName, size, result }: { fileName: string; size: number; result: ImportResult }) {
  const { t } = useTranslation();
  const rows = summaryRows(result, t);
  const unsupported = unsupportedRows(result, t);
  const restored = restoredLabels(result, t);

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3 rounded-2xl border border-border bg-card/40 px-4 py-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
          <Icon name="check" className="size-4" />
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{result.document.title}</p>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {t('import.dialog.fileMeta', {
              name: fileName,
              size: formatBytes(size),
              format: t(`import.formats.${result.format}`),
            })}
          </p>
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-3">
        {rows.map((row) => (
          <div key={row.label} className="rounded-xl border border-border/70 px-3 py-2">
            <dt className="text-xs text-muted-foreground">{row.label}</dt>
            <dd className="mt-1 text-sm font-medium">{row.value}</dd>
          </div>
        ))}
      </dl>

      <section>
        <h3 className="text-xs font-medium text-muted-foreground">{t('import.dialog.restored')}</h3>
        {restored.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">{t('import.dialog.restoredNone')}</p>
        ) : (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {restored.map((label) => (
              <span key={label} className="rounded-full bg-secondary px-2.5 py-1 text-xs text-secondary-foreground">
                {label}
              </span>
            ))}
          </div>
        )}
      </section>

      {unsupported.length > 0 ? (
        <section>
          <h3 className="text-xs font-medium text-muted-foreground">
            {t('import.dialog.unsupported', { n: unsupported.length })}
          </h3>
          <ul className="mt-2 space-y-1">
            {unsupported.map((row) => (
              <li key={row.label} className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">{row.label}</span>
                <span className="tabular-nums text-muted-foreground">{row.value}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {result.warnings.length > 0 ? (
        <section>
          <h3 className="text-xs font-medium text-muted-foreground">{t('import.dialog.warnings')}</h3>
          <ul className="mt-2 space-y-1.5">
            {result.warnings.map((warning) => (
              <li key={`${warning.code}:${JSON.stringify(warning.params ?? {})}`} className="flex items-start gap-2 text-sm text-muted-foreground">
                <Icon name="alert" className="mt-0.5 size-3.5 shrink-0" />
                <span className="min-w-0 break-words">{importWarningText(warning, t)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
