import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@/lib/api/errors';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { fileApi } from '@/lib/api/files';
import { mapApi } from '@/lib/api/maps';
import { parseDocument } from '@/editor/model/validate';
import { importRegistry } from '@/editor/import/builtins';
import { finalizeImport } from '@/editor/import/finalize';
import type { ImportResult } from '@/editor/import/types';
import type { Topic, WmindDocument } from '@/editor/model/types';
import {
  completeOpenFile,
  fetchMapBySource,
  fetchOpenFiles,
  isDesktop,
  readOpenFileBytes,
  type DesktopOpenFile,
} from '@/lib/desktop';
import { XmindReadonlyDialog } from './xmind-readonly-dialog';

interface XmindPending {
  item: DesktopOpenFile;
  result: ImportResult;
  previewDocument: WmindDocument;
  previewUrls: string[];
}

function eachPreviewTopic(document: WmindDocument, visit: (topic: Topic) => void): void {
  const stack: Topic[] = [];
  for (const sheet of document.sheets) {
    stack.push(sheet.rootTopic, ...sheet.floatingTopics);
  }
  while (stack.length > 0) {
    const topic = stack.pop();
    if (!topic) continue;
    visit(topic);
    stack.push(...topic.children.attached, ...topic.children.detached);
  }
}

function buildXmindPreview(result: ImportResult): { document: WmindDocument; urls: string[] } {
  const document = structuredClone(result.document);
  const byRef = new Map(result.assets.map((asset) => [asset.ref, asset]));
  const urls: string[] = [];
  eachPreviewTopic(document, (topic) => {
    if (!topic.image) return;
    const asset = byRef.get(topic.image.src);
    if (!asset) return;
    const url = URL.createObjectURL(new Blob([asset.bytes], { type: asset.mime }));
    urls.push(url);
    topic.image.src = url;
  });
  return { document, urls };
}

/**
 * 桌面文件关联的全局宿主。
 *
 * 不能挂在最近列表页：用户可能正在编辑器、模板或回收站页，双击文件仍应该
 * 打开；也不能只靠 Go -> WebView 的事件，因为冷启动时页面还没建好。这里用
 * 「立即拉一次 + 可见时轮询 + 自定义事件唤醒」三层兜底，并且严格串行消费。
 */
export function OpenFileHost() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const desktop = isDesktop();
  const [items, setItems] = useState<DesktopOpenFile[]>([]);
  const [xmind, setXmind] = useState<XmindPending | null>(null);
  const [error, setError] = useState<{ item: DesktopOpenFile; message: string } | null>(null);
  const processing = useRef(false);
  const handled = useRef(new Set<string>());

  const refresh = useCallback(async () => {
    if (!desktop || document.visibilityState === 'hidden') return;
    try {
      const next = await fetchOpenFiles();
      setItems(next.filter((item) => !handled.current.has(item.id)));
    } catch {
      // 桌面壳启动后端/页面切换时短暂失败是正常的；下一次轮询重试。
    }
  }, [desktop]);

  useEffect(() => {
    if (!desktop) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1000);
    const onVisible = () => { if (document.visibilityState === 'visible') void refresh(); };
    const onOpen = () => void refresh();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('wmind:open-file', onOpen);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('wmind:open-file', onOpen);
    };
  }, [desktop, refresh]);

  const finish = useCallback(async (item: DesktopOpenFile, mapUid?: string): Promise<boolean> => {
    handled.current.add(item.id);
    setItems((current) => current.filter((candidate) => candidate.id !== item.id));
    try {
      await completeOpenFile(item.id, mapUid);
    } catch {
      // Keep this launch hidden for the current session: if map creation already
      // succeeded, retrying the whole pipeline would create a duplicate. The
      // server-side queue remains available for a later application restart.
      return false;
    }
    await refresh();
    return true;
  }, [refresh]);

  const fail = useCallback(async (item: DesktopOpenFile, message: string) => {
    await finish(item);
    setError({ item, message });
  }, [finish]);

  const createFromDocument = useCallback(async (item: DesktopOpenFile, document: ReturnType<typeof parseDocument>['document']) => {
    const created = await mapApi.create({ title: document.title || item.name.replace(/\.[^.]+$/, ''), document });
    if (!await finish(item, created.uid)) {
      setError({ item, message: t('desktop.openFile.completeFailed') });
      return;
    }
    navigate(`/maps/${encodeURIComponent(created.uid)}`);
  }, [finish, navigate, t]);

  useEffect(() => {
    if (!desktop || processing.current || xmind || error || items.length === 0) return;
    const item = items[0]!;
    processing.current = true;
    void (async () => {
      try {
        if (item.missing) {
          await fail(item, t('desktop.openFile.missing'));
          return;
        }
        // 先按来源去重，并验证导图仍然存在；旧版本残留的来源记录不会把用户
        // 导到一个 404 编辑页。
        try {
          const source = await fetchMapBySource(item.path);
          if (source.exists) {
            try {
              await mapApi.get(source.mapUid);
              if (await finish(item)) navigate(`/maps/${encodeURIComponent(source.mapUid)}`);
              return;
            } catch (cause) {
              if (!(cause instanceof ApiError) || cause.code !== 'MAP_NOT_FOUND') throw cause;
              /* stale source; parse and create a fresh map */
            }
          }
        } catch (cause) {
          // A missing source is the normal first-open path. Other failures (for
          // example a temporary local API outage) must abort this launch instead
          // of silently creating a duplicate map.
          if (!(cause instanceof Error) || (!cause.message.includes('(404)') && !cause.message.includes('没有来源记录') && !cause.message.includes('No source record'))) throw cause;
        }

        const bytes = new Uint8Array(await readOpenFileBytes(item.id));
        if (item.ext === 'wmind') {
          let raw: unknown;
          try { raw = JSON.parse(new TextDecoder().decode(bytes)); }
          catch { throw new Error(t('desktop.openFile.invalidWmind')); }
          await createFromDocument(item, parseDocument(raw).document);
          return;
        }

        const parsed = importRegistry.run({ fileName: item.name, bytes });
        const preview = buildXmindPreview(parsed);
        setXmind({ item, result: parsed, previewDocument: preview.document, previewUrls: preview.urls });
      } catch (cause) {
        await fail(item, cause instanceof Error ? cause.message : t('desktop.openFile.failed'));
      } finally {
        processing.current = false;
      }
    })();
  }, [createFromDocument, desktop, error, fail, finish, items, navigate, t, xmind]);

  if (!desktop) return null;

  const closeXmind = () => {
    if (!xmind) return;
    const current = xmind;
    setXmind(null);
    for (const url of current.previewUrls) URL.revokeObjectURL(url);
    void finish(current.item);
  };
  const convertXmind = () => {
    if (!xmind) return;
    const current = xmind;
    setXmind(null);
    for (const url of current.previewUrls) URL.revokeObjectURL(url);
    void finalizeImport(current.result, { upload: fileApi.upload })
      .then((finalized) => createFromDocument(current.item, finalized.result.document))
      .catch((cause) => {
        processing.current = false;
        setError({ item: current.item, message: cause instanceof Error ? cause.message : t('desktop.openFile.failed') });
      });
  };

  return (
    <>
      {xmind ? (
        <XmindReadonlyDialog
          open
          title={xmind.item.name}
          document={xmind.previewDocument}
          onClose={closeXmind}
          onConvert={convertXmind}
        />
      ) : null}
      <Modal
        open={error !== null}
        title={t('desktop.openFile.failedTitle')}
        onClose={() => setError(null)}
        footer={<Button onClick={() => setError(null)}>{t('common.close')}</Button>}
      >
        <div className="space-y-3 text-sm">
          <Icon name="alert" className="size-8 text-destructive" />
          <p className="text-muted-foreground">{error?.message}</p>
          {error?.item ? <p className="break-all text-xs text-muted-foreground">{error.item.path}</p> : null}
        </div>
      </Modal>
    </>
  );
}
