/**
 * 导出对话框。
 *
 * 三个刻意的决定：
 *
 * 1. **预览就是导出结果本身**。左边那块 `<img>` 的 `src` 与「下载」按钮写出去
 *    的字节是**同一份** SVG（同一个 `buildExportSvg` 调用结果），不是另画一个
 *    近似预览。预览与成品不一致是导出功能最伤人的失败方式：用户看着好好的，
 *    拿到手发现少了一半内容。
 * 2. **选项变化时重新构建，而不是重新挂载**。`useMemo` 依赖文档与选项，
 *    改一个勾选框只会重算一次字符串；每次改选项都重建组件会让预览闪一下白。
 * 3. **尺寸写在按钮旁边**。用户最常问的是「导出来多大」——`2400 × 1600` 比
 *    「2 倍」直观得多，尤其是准备贴进文档或 PPT 的时候。
 * 4. **图片先内嵌再出图**。节点图片的地址可能是 `/uploads/…` 或外链，两种
 *    都只在应用里有效。`assets.ts` 把它们换成 `data:` URL；换不回来的会
 *    在底部明说「N 张图片未能内嵌」，而不是让用户以为导出是完整的。
 */

import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import {
  DEFAULT_EXPORT_OPTIONS,
  buildExportContext,
  type ExportOptions,
} from '@/editor/export/context';
import {
  applyImageSources,
  collectImageSources,
  loadImageSources,
} from '@/editor/export/assets';
import { downloadBlob, downloadSvg } from '@/editor/export/download';
import { checkRasterSize, rasterizeSvg } from '@/editor/export/raster';
import { buildExportSvg, exportFileName, svgDataUrl } from '@/editor/export/svg';
import type { WmindDocument } from '@/editor/model/types';

export interface ExportDialogProps {
  open: boolean;
  document: WmindDocument;
  /** 当前画布 id；为空时按第一张处理。 */
  sheetId: string | null;
  onClose(): void;
}

const SCALES = [1, 2, 3, 4] as const;
const PADDINGS = [0, 24, 40, 80] as const;

/**
 * 格式选项。顺序即 UI 顺序：矢量在前，因为它是唯一无损的那个。
 *
 * `descriptionKey` 单独给而不是共用一句：SVG 说「可无损缩放」，PNG 说「按倍率
 * 栅格化」，JPEG 说「不支持透明」——三句话回答的是三个不同的问题，共用一句
 * 就等于两句是错的。
 */
const FORMATS: {
  id: ExportOptions['format'];
  labelKey: string;
  descriptionKey: string;
  ext: string;
}[] = [
  { id: 'svg', labelKey: 'editor.export.formatSvg', descriptionKey: 'editor.export.description', ext: 'svg' },
  { id: 'png', labelKey: 'editor.export.formatPng', descriptionKey: 'editor.export.descriptionPng', ext: 'png' },
  { id: 'jpeg', labelKey: 'editor.export.formatJpeg', descriptionKey: 'editor.export.descriptionJpeg', ext: 'jpg' },
];

export function ExportDialog({ open, document: doc, sheetId, onClose }: ExportDialogProps) {
  const { t } = useTranslation();
  const [options, setOptions] = useState<ExportOptions>(DEFAULT_EXPORT_OPTIONS);

  const patch = (next: Partial<ExportOptions>) => setOptions((current) => ({ ...current, ...next }));

  const baseCtx = useMemo(() => buildExportContext(doc, sheetId, options), [doc, sheetId, options]);

  // 图片地址（去重后）与它们的 `data:` URL 映射。
  //
  // 依赖用 `join` 后的字符串而不是数组本身：`collectImageSources` 每次返回
  // 新数组，拿数组当依赖会让 effect 在每次改选项时都重跑一遍。字符串相等时
  // 图片集合没变，也就没必要再抓。
  const sourceList = useMemo(() => collectImageSources(baseCtx), [baseCtx]);
  const sourceKey = sourceList.join('\n');
  const [dataUrls, setDataUrls] = useState<ReadonlyMap<string, string>>(() => new Map());

  useEffect(() => {
    if (sourceKey === '') return;
    // 刻意不挂「组件已卸载」的 `alive` 闸门。
    //
    // 开发期 StrictMode 会把 effect 跑两遍（挂载 → 卸载 → 再挂载），第一遍的
    // 清理函数会在它的 promise 落地之前就把 `alive` 置 false——结果就是图抓回来
    // 了、状态却没更新，导出的 SVG 里留着一堆死链。React 18 起卸载后 setState
    // 本来就不会告警也不会泄漏，这道闸门只带来了这个 bug。
    void loadImageSources(sourceKey.split('\n')).then((loaded) => {
      if (loaded.size === 0) return;
      setDataUrls((prev) => new Map([...prev, ...loaded]));
    });
  }, [sourceKey]);

  const ctx = useMemo(() => applyImageSources(baseCtx, dataUrls), [baseCtx, dataUrls]);
  const markup = useMemo(() => buildExportSvg(ctx), [ctx]);
  const dataUrl = useMemo(() => svgDataUrl(markup), [markup]);

  // 抓不回来的图（跨域被拒、外链失效、超时）在成品里仍是原地址。默默留着
  // 会让用户以为导出是完整的——所以如实说出来。
  const missingImages = sourceList.filter((src) => !dataUrls.has(src)).length;

  const multiSheet = doc.sheets.length > 1;
  const format = FORMATS.find((item) => item.id === options.format) ?? FORMATS[0]!;

  // 位图的输出像素尺寸。SVG 没有这个上限——它是矢量的，再大也只是字符串长一点。
  const outputWidth = Math.round(ctx.width * ctx.scale);
  const outputHeight = Math.round(ctx.height * ctx.scale);
  const rasterVerdict =
    options.format === 'svg' ? { kind: 'ok' as const } : checkRasterSize(outputWidth, outputHeight);

  const [busy, setBusy] = useState(false);

  const download = async () => {
    if (options.format === 'svg') {
      downloadSvg(markup, exportFileName(ctx.title, 'svg'));
      onClose();
      return;
    }
    if (rasterVerdict.kind === 'too-large') return;

    setBusy(true);
    try {
      const blob = await rasterizeSvg(markup, {
        width: outputWidth,
        height: outputHeight,
        format: options.format,
        background: ctx.background,
      });
      downloadBlob(blob, exportFileName(ctx.title, format.ext));
      onClose();
    } catch {
      // 失败时留在对话框里：关掉再重开会丢掉用户刚调的选项。
      toast.error(t('editor.export.failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={t('editor.export.title')}
      description={t(format.descriptionKey)}
      footer={
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 text-xs text-muted-foreground">
            <span>
              {t('editor.export.size', { width: outputWidth, height: outputHeight })}
            </span>
            {rasterVerdict.kind === 'too-large' ? (
              <span className="ml-2 text-destructive">
                {t('editor.export.tooLarge', {
                  width: outputWidth,
                  height: outputHeight,
                  limit: rasterVerdict.limit,
                })}
              </span>
            ) : null}
            {rasterVerdict.kind === 'warn' ? (
              <span className="ml-2 text-amber-600 dark:text-amber-400">
                {t('editor.export.largeWarn', { width: outputWidth, height: outputHeight })}
              </span>
            ) : null}
            {missingImages > 0 ? (
              <span className="ml-2 text-amber-600 dark:text-amber-400">
                {t('editor.export.imageFailed', { count: missingImages })}
              </span>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button variant="ghost" size="sm" onClick={onClose}>
              {t('editor.export.cancel')}
            </Button>
            <Button
              size="sm"
              onClick={() => void download()}
              disabled={busy || rasterVerdict.kind === 'too-large'}
            >
              {busy
                ? t('editor.export.generating')
                : t('editor.export.downloadAs', { format: t(format.labelKey) })}
            </Button>
          </div>
        </div>
      }
    >
      <div className="flex flex-col gap-4 sm:flex-row">
        {/* 预览：棋盘格底，透明背景时能直接看出来 */}
        <div
          className="flex max-h-[52vh] min-h-40 flex-1 items-center justify-center overflow-auto rounded-xl border border-border p-3"
          style={{
            backgroundColor: ctx.background ?? 'transparent',
            backgroundImage:
              ctx.background === null
                ? 'linear-gradient(45deg, #e5e7eb 25%, transparent 25%), linear-gradient(-45deg, #e5e7eb 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #e5e7eb 75%), linear-gradient(-45deg, transparent 75%, #e5e7eb 75%)'
                : undefined,
            backgroundSize: ctx.background === null ? '16px 16px' : undefined,
            backgroundPosition: ctx.background === null ? '0 0, 0 8px, 8px -8px, -8px 0' : undefined,
          }}
        >
          <img
            src={dataUrl}
            alt={t('editor.export.previewAlt')}
            className="max-h-[46vh] max-w-full object-contain"
          />
        </div>

        <div className="flex w-full shrink-0 flex-col gap-3 sm:w-52">
          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1 text-xs font-semibold text-foreground">
              {t('editor.export.format')}
            </legend>
            {FORMATS.map((item) => (
              <label key={item.id} className="flex items-center gap-2 text-xs text-foreground">
                <input
                  type="radio"
                  name="export-format"
                  checked={options.format === item.id}
                  onChange={() => patch({ format: item.id })}
                />
                {t(item.labelKey)}
              </label>
            ))}
          </fieldset>

          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1 text-xs font-semibold text-foreground">
              {t('editor.export.scope')}
            </legend>
            <label className="flex items-center gap-2 text-xs text-foreground">
              <input
                type="radio"
                name="export-scope"
                checked={options.scope === 'current'}
                onChange={() => patch({ scope: 'current' })}
              />
              {t('editor.export.scopeCurrent')}
            </label>
            <label className="flex items-center gap-2 text-xs text-foreground">
              <input
                type="radio"
                name="export-scope"
                checked={options.scope === 'all'}
                // 只有一张画布时「全部」与「当前」等价，禁用比让人选一个没差别的
                // 选项更诚实。
                disabled={!multiSheet}
                onChange={() => patch({ scope: 'all' })}
              />
              {t('editor.export.scopeAll', { count: doc.sheets.length })}
            </label>
          </fieldset>

          <label className="flex flex-col gap-1 text-xs font-semibold text-foreground">
            {t('editor.export.scale')}
            <select
              value={options.scale}
              onChange={(event) => patch({ scale: Number(event.target.value) })}
              className="h-8 rounded-md border border-input bg-background px-2 text-xs font-normal text-foreground"
            >
              {SCALES.map((scale) => (
                <option key={scale} value={scale}>
                  {t('editor.export.scaleValue', { n: scale })}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-xs font-semibold text-foreground">
            {t('editor.export.padding')}
            <select
              value={options.padding}
              onChange={(event) => patch({ padding: Number(event.target.value) })}
              className="h-8 rounded-md border border-input bg-background px-2 text-xs font-normal text-foreground"
            >
              {PADDINGS.map((padding) => (
                <option key={padding} value={padding}>
                  {padding === 0 ? t('editor.export.paddingNone') : `${padding}px`}
                </option>
              ))}
            </select>
          </label>

          <div className="flex flex-col gap-1.5">
            {([
              ['transparent', t('editor.export.transparent')],
              ['border', t('editor.export.border')],
              ['date', t('editor.export.date')],
              ['brand', t('editor.export.brand')],
            ] as const).map(([key, label]) => (
              <label key={key} className="flex items-center gap-2 text-xs text-foreground">
                <input
                  type="checkbox"
                  checked={options[key]}
                  onChange={(event) => patch({ [key]: event.target.checked })}
                />
                {label}
              </label>
            ))}
            {options.format === 'jpeg' && options.transparent ? (
              // 勾着「透明背景」却导 JPEG，预览里是白底——不解释一句，用户会以为
              // 透明选项失效了。
              <p className="text-[11px] leading-snug text-amber-600 dark:text-amber-400">
                {t('editor.export.jpegOpaque')}
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </Modal>
  );
}
