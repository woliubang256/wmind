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
 */

import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Modal } from '@/components/ui/modal';
import { mapApi } from '@/lib/api/maps';
import { formatBytes } from '@/lib/format';
import { importAcceptAttribute, importRegistry } from '@/editor/import/builtins';
import { IMPORT_LIMITS } from '@/editor/import/limits';
import type { ImportResult } from '@/editor/import/types';
import {
  importErrorMessage,
  importWarningText,
  restoredLabels,
  summaryRows,
  unsupportedRows,
} from './import-present';

type Phase =
  | { kind: 'idle' }
  | { kind: 'parsing'; fileName: string }
  | { kind: 'ready'; fileName: string; size: number; result: ImportResult }
  | { kind: 'failed'; fileName: string; message: string };

export interface ImportDialogProps {
  open: boolean;
  onClose: () => void;
  /** 从页面拖进来的文件。消费后调用 `onFileConsumed`，避免重开对话框时重复导入。 */
  initialFile?: File | null;
  onFileConsumed?: () => void;
}

export function ImportDialog({ open, onClose, initialFile, onFileConsumed }: ImportDialogProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [dragging, setDragging] = useState(false);
  const [creating, setCreating] = useState(false);

  // 关闭后复位。放在这里而不是 onClose 里：Esc、点遮罩、外部调用都会经过 open。
  useEffect(() => {
    if (!open) {
      setPhase({ kind: 'idle' });
      setDragging(false);
      setCreating(false);
    }
  }, [open]);

  const runImport = async (file: File) => {
    if (file.size > IMPORT_LIMITS.maxInputBytes) {
      setPhase({
        kind: 'failed',
        fileName: file.name,
        message: t('import.error.FILE_TOO_LARGE', {
          size: formatBytes(file.size),
          limit: formatBytes(IMPORT_LIMITS.maxInputBytes),
        }),
      });
      return;
    }

    setPhase({ kind: 'parsing', fileName: file.name });
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      // 让出一帧，否则「正在解析」来不及渲染。
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
      const result = importRegistry.run({ fileName: file.name, bytes });
      setPhase({ kind: 'ready', fileName: file.name, size: file.size, result });
    } catch (error) {
      setPhase({ kind: 'failed', fileName: file.name, message: importErrorMessage(error, t) });
    }
  };

  // 页面级拖放带进来的文件。
  useEffect(() => {
    if (!open || !initialFile) return;
    onFileConsumed?.();
    void runImport(initialFile);
    // runImport 每次渲染都是新函数，但这里只该在「打开 + 有新文件」时跑一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialFile]);

  const pickFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    if (files.length > 1) {
      toast.warning(t('import.dialog.multipleFiles'));
    }
    void runImport(files[0] as File);
  };

  const confirm = async () => {
    if (phase.kind !== 'ready') return;
    setCreating(true);
    try {
      const created = await mapApi.create({
        title: phase.result.document.title,
        document: phase.result.document,
      });
      onClose();
      navigate(`/maps/${created.uid}`);
    } catch {
      toast.error(t('import.dialog.createFailed'));
    } finally {
      setCreating(false);
    }
  };

  const footer =
    phase.kind === 'ready' ? (
      <div className="grid grid-cols-2 gap-2">
        <Button variant="outline" onClick={onClose} disabled={creating}>
          {t('import.dialog.cancel')}
        </Button>
        <Button onClick={() => void confirm()} disabled={creating}>
          <Icon name="check" className="size-4" />
          {creating ? t('import.dialog.creating') : t('import.dialog.create')}
        </Button>
      </div>
    ) : phase.kind === 'failed' ? (
      <div className="grid grid-cols-2 gap-2">
        <Button variant="outline" onClick={onClose}>
          {t('import.dialog.cancel')}
        </Button>
        <Button onClick={() => setPhase({ kind: 'idle' })}>{t('import.dialog.retry')}</Button>
      </div>
    ) : (
      <Button variant="outline" onClick={onClose}>
        {t('import.dialog.cancel')}
      </Button>
    );

  return (
    <Modal
      open={open}
      size="lg"
      title={phase.kind === 'ready' ? t('import.dialog.summaryTitle') : t('import.dialog.title')}
      description={phase.kind === 'ready' ? t('import.dialog.summaryDescription') : t('import.dialog.description')}
      onClose={onClose}
      footer={footer}
    >
      {phase.kind === 'idle' ? (
        <div
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
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
            <p className="mt-1 text-xs text-muted-foreground">{t('import.dialog.parsing')}</p>
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
        <ImportSummary fileName={phase.fileName} size={phase.size} result={phase.result} />
      ) : null}
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
