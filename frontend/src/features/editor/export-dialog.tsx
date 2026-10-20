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
  SCALE_MAX,
  SCALE_MIN,
  buildExportContext,
  clampScale,
  isTextFormat,
  presetHasFill,
  type AspectRatioId,
  type BorderStyleId,
  type ExportFormat,
  type ExportOptions,
} from '@/editor/export/context';
import {
  applyImageSources,
  collectImageSources,
  loadImageSources,
} from '@/editor/export/assets';
import { downloadBlob, downloadSvg } from '@/editor/export/download';
import { detectFallback } from '@/editor/export/fonts';
import { checkRasterSize, rasterizeSvg } from '@/editor/export/raster';
import { exportBranches, planBranches, svgEncoder } from '@/editor/export/split';
import { buildExportSvg, exportFileName, svgDataUrl } from '@/editor/export/svg';
import { exportMarkdown, exportOpml } from '@/editor/export/text';
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

/** 边框预设的展示顺序与文案。 */
const BORDER_ORDER: BorderStyleId[] = ['none', 'thin', 'red', 'orange', 'green', 'blue'];
const BORDER_LABELS: Record<BorderStyleId, string> = {
  none: 'editor.export.borderNone',
  thin: 'editor.export.borderThin',
  red: 'editor.export.borderRed',
  orange: 'editor.export.borderOrange',
  green: 'editor.export.borderGreen',
  blue: 'editor.export.borderBlue',
};

/** 长宽比的展示顺序与文案。 */
const ASPECT_ORDER: AspectRatioId[] = ['auto', '16:9', '4:3', '1:1', '9:16'];
const ASPECT_LABELS: Record<AspectRatioId, string> = {
  auto: 'editor.export.aspectAuto',
  '16:9': 'editor.export.aspect16x9',
  '4:3': 'editor.export.aspect4x3',
  '1:1': 'editor.export.aspect1x1',
  '9:16': 'editor.export.aspect9x16',
};

/**
 * 格式选项。顺序即 UI 顺序：矢量在前，因为它是唯一无损的那个；文本格式垫底，
 * 因为它们丢样式——不该出现在第一眼看到的位置。
 *
 * `descriptionKey` 单独给而不是共用一句：SVG 说「可无损缩放」，PNG 说「按倍率
 * 栅格化」，JPEG 说「不支持透明」——三句话回答的是三个不同的问题，共用一句
 * 就等于两句是错的。
 */
const FORMATS: {
  id: ExportFormat;
  labelKey: string;
  descriptionKey: string;
  ext: string;
  /** 文本格式下载时用的 MIME；矢量/位图走各自的分支，这里留空。 */
  mime?: string;
}[] = [
  { id: 'svg', labelKey: 'editor.export.formatSvg', descriptionKey: 'editor.export.description', ext: 'svg' },
  { id: 'png', labelKey: 'editor.export.formatPng', descriptionKey: 'editor.export.descriptionPng', ext: 'png' },
  { id: 'jpeg', labelKey: 'editor.export.formatJpeg', descriptionKey: 'editor.export.descriptionJpeg', ext: 'jpg' },
  {
    id: 'md',
    labelKey: 'editor.export.formatMd',
    descriptionKey: 'editor.export.descriptionMd',
    ext: 'md',
    mime: 'text/markdown;charset=utf-8',
  },
  {
    id: 'opml',
    labelKey: 'editor.export.formatOpml',
    descriptionKey: 'editor.export.descriptionOpml',
    ext: 'opml',
    mime: 'text/x-opml;charset=utf-8',
  },
];

export function ExportDialog({ open, document: doc, sheetId, onClose }: ExportDialogProps) {
  const { t } = useTranslation();
  const [options, setOptions] = useState<ExportOptions>(DEFAULT_EXPORT_OPTIONS);

  const patch = (next: Partial<ExportOptions>) => setOptions((current) => ({ ...current, ...next }));

  const baseCtx = useMemo(() => buildExportContext(doc, sheetId, options), [doc, sheetId, options]);

  const text = isTextFormat(options.format);

  // 文本格式直接从文档模型序列化。布局上下文仍然会算（下面要用它的标题，
  // 而且它本来就在每次改选项时重算），但**跳过了 SVG 构建与 base64 编码**——
  // 一张巨型导图那两步要几百毫秒，而结果最后会被丢掉。
  const textContent = useMemo(() => {
    if (options.format === 'md') return exportMarkdown(doc, sheetId);
    if (options.format === 'opml') return exportOpml(doc, sheetId);
    return null;
  }, [doc, sheetId, options.format]);

  // 图片地址（去重后）与它们的 `data:` URL 映射。
  //
  // 依赖用 `join` 后的字符串而不是数组本身：`collectImageSources` 每次返回
  // 新数组，拿数组当依赖会让 effect 在每次改选项时都重跑一遍。字符串相等时
  // 图片集合没变，也就没必要再抓。
  const sourceList = useMemo(() => (text ? [] : collectImageSources(baseCtx)), [baseCtx, text]);
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
  const markup = useMemo(() => (text ? '' : buildExportSvg(ctx)), [ctx, text]);
  const dataUrl = useMemo(() => (markup === '' ? '' : svgDataUrl(markup)), [markup]);

  // 抓不回来的图（跨域被拒、外链失效、超时）在成品里仍是原地址。默默留着
  // 会让用户以为导出是完整的——所以如实说出来。
  const missingImages = sourceList.filter((src) => !dataUrls.has(src)).length;

  // 内置字体里没有字形的字符。文本格式不画字，跳过。
  //
  // 这条提示与「图片没内嵌」是同一类：不说的话，用户在别人的机器上打开才发现
  // 某个字长得不一样，而且完全不知道为什么。取前 5 个字符做样本——只说个数
  // 用户没法判断要不要处理。
  const fallback = useMemo(
    () => (text ? { chars: [] as string[], count: 0 } : detectFallback(ctx)),
    [ctx, text],
  );
  const fallbackSample = fallback.chars.slice(0, 5).join(' ') + (fallback.chars.length > 5 ? ' …' : '');

  const multiSheet = doc.sheets.length > 1;
  const format = FORMATS.find((item) => item.id === options.format) ?? FORMATS[0]!;

  // 位图的输出像素尺寸。SVG 没有这个上限——它是矢量的，再大也只是字符串长一点。
  const outputWidth = Math.round(ctx.width * ctx.scale);
  const outputHeight = Math.round(ctx.height * ctx.scale);
  // 只有 PNG / JPEG 需要过尺寸闸门。文本格式若也走一遍，一张巨型导图会被判成
  // 「太大」并把「下载」按钮禁掉——导个 Markdown 而已。
  const needsRaster = options.format === 'png' || options.format === 'jpeg';
  const rasterVerdict = needsRaster ? checkRasterSize(outputWidth, outputHeight) : { kind: 'ok' as const };

  const [busy, setBusy] = useState(false);

  // 「自定义倍率」是**界面状态**，不进 ExportOptions。
  //
  // 试过只用 `isPresetScale(options.scale)` 判断要不要显示输入框：选「自定义」时
  // 倍率还是 2，判断结果仍是「预设」，下拉立刻弹回 2×，输入框永远不出现。
  // 模式与数值必须分开记。
  const [customScale, setCustomScale] = useState(false);

  // 「按主分支拆分」也只是界面状态：它不改变导出上下文，只改变**产出几个文件**。
  const [split, setSplit] = useState(false);
  const branches = useMemo(() => (text ? [] : planBranches(doc, sheetId)), [doc, sheetId, text]);

  const download = async () => {
    if (textContent !== null) {
      // 文本是同步生成的字符串，没有异步失败路径，所以不必包 try/catch。
      // 带上 charset：不带的话 Windows 上的编辑器会按 GBK 打开，中文全成乱码。
      const blob = new Blob([textContent], { type: format.mime ?? 'text/plain;charset=utf-8' });
      downloadBlob(blob, exportFileName(ctx.title, format.ext));
      onClose();
      return;
    }

    if (split && branches.length > 1) {
      setBusy(true);
      try {
        const rasterFormat = options.format === 'jpeg' ? 'jpeg' : 'png';
        const result = await exportBranches(doc, sheetId, options, format.ext, {
          // 图片内嵌对拆分同样有效：每张分支图也要把 `/uploads/…` 换成 data URL，
          // 否则打出来的 zip 里全是指回本机的死链。
          prepare: (raw) => applyImageSources(raw, dataUrls),
          encode:
            options.format === 'svg'
              ? svgEncoder
              : async (raw, svg) => {
                  const blob = await rasterizeSvg(svg, {
                    width: Math.round(raw.width * raw.scale),
                    height: Math.round(raw.height * raw.scale),
                    format: rasterFormat,
                    background: raw.background,
                  });
                  return new Uint8Array(await blob.arrayBuffer());
                },
        });
        downloadBlob(
          new Blob([result.bytes as BlobPart], { type: 'application/zip' }),
          exportFileName(ctx.title, 'zip'),
        );
        onClose();
      } catch {
        toast.error(t('editor.export.failed'));
      } finally {
        setBusy(false);
      }
      return;
    }

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
        format: options.format === 'jpeg' ? 'jpeg' : 'png',
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
              {textContent !== null
                ? t('editor.export.textSize', { count: textContent.length })
                : split && branches.length > 1
                  // 拆分时逐张尺寸不同，报一个数只会误导；报文件数才有用。
                  ? t('editor.export.splitFiles', { count: branches.length })
                  : t('editor.export.size', { width: outputWidth, height: outputHeight })}
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
            {fallback.count > 0 ? (
              <span className="ml-2 text-amber-600 dark:text-amber-400">
                {t('editor.export.fontFallback', { count: fallback.count, chars: fallbackSample })}
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
                : split && branches.length > 1
                  ? t('editor.export.downloadZip')
                  : t('editor.export.downloadAs', { format: t(format.labelKey) })}
            </Button>
          </div>
        </div>
      }
    >
      <div className="flex flex-col gap-4 sm:flex-row">
        {/* 预览：棋盘格底，透明背景时能直接看出来。
            文本格式换成等宽文本——那种格式没有「画出来」的样子，画一张图反而是骗人。 */}
        <div
          className={`flex max-h-[52vh] min-h-40 flex-1 overflow-auto rounded-xl border border-border p-3 ${
            textContent === null ? 'items-center justify-center' : 'items-start justify-start'
          }`}
          style={
            textContent !== null
              ? undefined
              : {
                  backgroundColor: ctx.background ?? 'transparent',
                  backgroundImage:
                    ctx.background === null
                      ? 'linear-gradient(45deg, #e5e7eb 25%, transparent 25%), linear-gradient(-45deg, #e5e7eb 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #e5e7eb 75%), linear-gradient(-45deg, transparent 75%, #e5e7eb 75%)'
                      : undefined,
                  backgroundSize: ctx.background === null ? '16px 16px' : undefined,
                  backgroundPosition: ctx.background === null ? '0 0, 0 8px, 8px -8px, -8px 0' : undefined,
                }
          }
        >
          {textContent === null ? (
            <img
              src={dataUrl}
              alt={t('editor.export.previewAlt')}
              className="max-h-[46vh] max-w-full object-contain"
            />
          ) : (
            <pre
              data-testid="export-text-preview"
              className="w-full whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-foreground"
            >
              {textContent}
            </pre>
          )}
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

          {textContent === null ? (
            <>
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
                <div className="flex items-center gap-1.5">
                  <select
                    value={customScale ? 'custom' : String(options.scale)}
                    onChange={(event) => {
                      const value = event.target.value;
                      if (value === 'custom') {
                        setCustomScale(true);
                        // 保持当前倍率不动：直接跳到某个默认值会让用户以为他选的
                        // 倍率被改掉了。
                        patch({ scale: clampScale(options.scale) });
                      } else {
                        setCustomScale(false);
                        patch({ scale: Number(value) });
                      }
                    }}
                    className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-xs font-normal text-foreground"
                  >
                    {SCALES.map((scale) => (
                      <option key={scale} value={scale}>
                        {t('editor.export.scaleValue', { n: scale })}
                      </option>
                    ))}
                    <option value="custom">{t('editor.export.scaleCustom')}</option>
                  </select>
                  {customScale ? (
                    <input
                      type="number"
                      // 0.5 是下限：再小就是缩略图，用户不如直接看画布。
                      // 8 是上限：再大的位图基本一定撞上浏览器尺寸闸门，留着
                      // 只会让人点一次「太大」。
                      min={SCALE_MIN}
                      max={SCALE_MAX}
                      step={0.1}
                      value={options.scale}
                      onChange={(event) => patch({ scale: clampScale(Number(event.target.value)) })}
                      className="h-8 w-16 rounded-md border border-input bg-background px-2 text-xs font-normal text-foreground"
                      // 名字不能与下拉里的「自定义」相同：`<label>` 包着整个选择区，
                      // 隐式关联会落到第一个可标注元素（下拉）上，两个控件撞名之后
                      // 屏幕阅读器与自动化都分不清谁是谁。
                      aria-label={t('editor.export.scaleCustomValue')}
                    />
                  ) : null}
                </div>
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

              <label className="flex flex-col gap-1 text-xs font-semibold text-foreground">
                {t('editor.export.aspect')}
                <select
                  value={options.aspect}
                  onChange={(event) => patch({ aspect: event.target.value as AspectRatioId })}
                  className="h-8 rounded-md border border-input bg-background px-2 text-xs font-normal text-foreground"
                >
                  {ASPECT_ORDER.map((id) => (
                    <option key={id} value={id}>
                      {t(ASPECT_LABELS[id])}
                    </option>
                  ))}
                </select>
              </label>

              <label className="flex flex-col gap-1 text-xs font-semibold text-foreground">
                {t('editor.export.border')}
                <select
                  value={options.border}
                  onChange={(event) => {
                    const next = event.target.value as BorderStyleId;
                    // 带底色的预设与「透明背景」互斥：选中时顺手把透明关掉，
                    // 免得留下「勾着透明却是绿底」这种自相矛盾的状态。
                    patch({ border: next, ...(presetHasFill(next) ? { transparent: false } : {}) });
                  }}
                  className="h-8 rounded-md border border-input bg-background px-2 text-xs font-normal text-foreground"
                >
                  {BORDER_ORDER.map((id) => (
                    <option key={id} value={id}>
                      {t(BORDER_LABELS[id])}
                    </option>
                  ))}
                </select>
              </label>

              <div className="flex flex-col gap-1.5">
                {([
                  ['transparent', t('editor.export.transparent')],
                  ['date', t('editor.export.date')],
                  ['brand', t('editor.export.brand')],
                ] as const).map(([key, label]) => (
                  <label key={key} className="flex items-center gap-2 text-xs text-foreground">
                    <input
                      type="checkbox"
                      checked={options[key]}
                      // 带底色的预设自带背景，透明背景在这时没有意义。
                      disabled={key === 'transparent' && presetHasFill(options.border)}
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
                {/* 只有一个分支时拆分没有意义：拆出来就是整张图。 */}
                {branches.length > 1 ? (
                  <label className="flex items-center gap-2 text-xs text-foreground">
                    <input
                      type="checkbox"
                      checked={split}
                      onChange={(event) => setSplit(event.target.checked)}
                    />
                    {t('editor.export.split', { count: branches.length })}
                  </label>
                ) : null}
              </div>
            </>
          ) : (
            // 文本格式没有任何「样式」可言：倍率、留白、透明背景、边框、日期、品牌
            // 全部不适用。与其把六个控件灰一屏，不如收起来，用一句话说清丢的是什么。
            <div className="flex flex-col gap-1.5">
              <p className="rounded-lg border border-amber-300/60 bg-amber-50 px-2.5 py-2 text-[11px] leading-snug text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
                {t('editor.export.textWarning')}
              </p>
              {multiSheet ? (
                // 序列化器一次只吃一张画布，多画布必须说出来，否则用户以为
                // 「全部」还在生效。
                <p className="text-[11px] leading-snug text-muted-foreground">
                  {t('editor.export.textSingleSheet')}
                </p>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
