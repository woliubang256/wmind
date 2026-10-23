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

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Modal } from '@/components/ui/modal';
import { RadioGroup } from '@/components/ui/radio-group';
import { Select } from '@/components/ui/select';
import {
  DEFAULT_EXPORT_OPTIONS,
  SCALE_MAX,
  SCALE_MIN,
  buildExportContext,
  clampScale,
  isDocumentFormat,
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
import { applyFontCss, loadFontCss, planFamilies } from '@/editor/export/font-embed';
import { detectFallback } from '@/editor/export/fonts';
import { checkRasterSize, rasterizeSvg } from '@/editor/export/raster';
import { exportBranches, planBranches, svgEncoder } from '@/editor/export/split';
import { buildImagePdf, jpegSize, pageSizePoints } from '@/editor/export/pdf';
import { buildExportSvg, exportFileName, svgDataUrl } from '@/editor/export/svg';
import { exportMarkdown, exportOpml } from '@/editor/export/text';
import { buildXmind, xmindOutline } from '@/editor/export/xmind';
import { useSiteConfig } from '@/features/site/use-site-config';
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
 * 内嵌字体超过这个长度（字符数≈base64 字节数）才提一句体积。
 *
 * 半兆以下不提：内嵌是默认行为，每次都报「我嵌了字体」只会变成噪音；而到了
 * 半兆以上，用户在下 SVG 时确实该知道文件为什么这么大。
 */
const FONT_SIZE_HINT_BYTES = 512 * 1024;

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
 * 格式选项。顺序即 UI 顺序：矢量在前，因为它是唯一无损的那个；`xmind` 排在
 * 位图之后、文本之前——它是**可再编辑**的，比 md/opml 保真得多；文本格式垫底，
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
  { id: 'pdf', labelKey: 'editor.export.formatPdf', descriptionKey: 'editor.export.descriptionPdf', ext: 'pdf' },
  {
    id: 'xmind',
    labelKey: 'editor.export.formatXmind',
    descriptionKey: 'editor.export.descriptionXmind',
    ext: 'xmind',
    mime: 'application/zip',
  },
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

/** point → 毫米。PDF 的页面单位是 1/72 英寸。 */
function mmOf(px: number): number {
  return Math.round(px * 0.75 * (25.4 / 72));
}

/**
 * 把刚栅格化出来的 JPEG 包成单页 PDF。
 *
 * 图像尺寸从 JPEG 字节里读，不从 `outputWidth` 拿：两者应当相等，但真出现
 * 差异时（浏览器对大图做降采样、`toBlob` 换了编码参数），声明错的 `/Width`
 * 会让阅读器拉伸或裁切，而且**完全不报错**——用户拿到的是一张看着「有点糊」
 * 的图，没有任何线索。以文件本身为准，至少不会错位。
 */
function toPdf(jpeg: Uint8Array, title: string, logicalWidth: number, logicalHeight: number): Uint8Array {
  const size = jpegSize(jpeg);
  if (size === null) throw new Error('PDF 需要 JPEG 位图');
  const page = pageSizePoints(logicalWidth, logicalHeight);
  return buildImagePdf({
    jpeg,
    imageWidth: size.width,
    imageHeight: size.height,
    pageWidth: page.width,
    pageHeight: page.height,
    title,
    creator: 'wmind',
  });
}

export function ExportDialog({ open, document: doc, sheetId, onClose }: ExportDialogProps) {
  const { t } = useTranslation();
  const [options, setOptions] = useState<ExportOptions>(DEFAULT_EXPORT_OPTIONS);

  const patch = (next: Partial<ExportOptions>) => setOptions((current) => ({ ...current, ...next }));

  // 品牌标识的默认文字来自站点设置（`site.brand`，留空时后端已回退成站点名）。
  //
  // 「打开时套用、但用户改过就不再套」：配置是异步来的，登录后第一次打开对话框
  // 时它可能还没落地；无脑同步会把用户刚敲的字覆盖掉，而只在挂载时同步又会让
  // 第一次打开拿到空串。用一个「碰过没有」的标记把两种时序都盖住。
  const { config } = useSiteConfig();
  const siteBrand = config.brand.trim() === '' ? config.siteName : config.brand;
  const brandTouched = useRef(false);

  useEffect(() => {
    if (!open) {
      // 关掉即复位：下一次打开又该重新套用站点设置。
      brandTouched.current = false;
      return;
    }
    if (brandTouched.current) return;
    setOptions((current) => (current.brandText === siteBrand ? current : { ...current, brandText: siteBrand }));
  }, [open, siteBrand]);

  const baseCtx = useMemo(() => buildExportContext(doc, sheetId, options), [doc, sheetId, options]);

  // 三个开关而不是一个，因为这三件事互不重叠：
  // - `plainText`：产出是字符串（md / opml），预览换成等宽文本；
  // - `structural`：产出是「结构」而不是一张图（含 xmind），倍率/留白/边框全不适用；
  // - `visual`：产出是一张图，只有它需要内嵌字体、构建 SVG、检查位图尺寸。
  // 用 `structural` 代替 `plainText` 会顺手把 xmind 的图片内嵌也跳过——而
  // `.xmind` 里的图片必须内嵌，否则文件到了别人手里就是一堆死链。
  const plainText = isTextFormat(options.format);
  const structural = isDocumentFormat(options.format);
  const visual = !structural;

  // 文本格式直接从文档模型序列化。布局上下文仍然会算（下面要用它的标题，
  // 而且它本来就在每次改选项时重算），但**跳过了 SVG 构建与 base64 编码**——
  // 一张巨型导图那两步要几百毫秒，而结果最后会被丢掉。
  const textContent = useMemo(() => {
    if (options.format === 'md') return exportMarkdown(doc, sheetId);
    if (options.format === 'opml') return exportOpml(doc, sheetId);
    return null;
  }, [doc, sheetId, options.format]);

  // `.xmind` 的预览：一份文本大纲。画成 Markdown 会让人以为导出的就是 Markdown，
  // 而这块 `<pre>` 该说明的只是「文件里有哪些节点」。
  const xmindPreview = useMemo(
    () => (options.format === 'xmind' ? xmindOutline(baseCtx) : null),
    [baseCtx, options.format],
  );

  // 图片地址（去重后）与它们的 `data:` URL 映射。
  //
  // 依赖用 `join` 后的字符串而不是数组本身：`collectImageSources` 每次返回
  // 新数组，拿数组当依赖会让 effect 在每次改选项时都重跑一遍。字符串相等时
  // 图片集合没变，也就没必要再抓。
  const sourceList = useMemo(() => (plainText ? [] : collectImageSources(baseCtx)), [baseCtx, plainText]);
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

  // 内嵌字体：把用到的分片读成 base64 塞进 SVG。
  //
  // 与图片内嵌同一个理由——导出的 SVG 是独立文件，`<img>` 载入时拿不到页面的
  // `@font-face`，不嵌就只能用系统字体画（实测字宽差 16%，文字会溢出节点框）。
  // 依赖用「族 + 字重 + 码位」拼出的签名：改倍率、留白、边框都不该重算字体，
  // 而加一个字就该重算。
  const fontPlan = useMemo(() => (visual ? planFamilies(baseCtx) : []), [baseCtx, visual]);
  const fontKey = fontPlan
    .map((need) => `${need.family}/${[...need.weights].sort().join(',')}/${[...need.codePoints].sort((a, b) => a - b).join(',')}`)
    .join('|');
  const [fontCss, setFontCss] = useState('');
  const [fontFaces, setFontFaces] = useState(0);

  useEffect(() => {
    if (fontKey === '') {
      setFontCss('');
      setFontFaces(0);
      return;
    }
    // 同图片那条：不挂卸载闸门，StrictMode 双跑时清理函数会先把结果丢掉。
    void loadFontCss(baseCtx).then((result) => {
      setFontCss(result.css);
      setFontFaces(result.faces);
    });
    // baseCtx 由 fontKey 唯一决定（族/字重/码位都变了才会换 key）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fontKey]);

  const ctx = useMemo(
    () => applyFontCss(applyImageSources(baseCtx, dataUrls), fontCss),
    [baseCtx, dataUrls, fontCss],
  );
  const markup = useMemo(() => (visual ? buildExportSvg(ctx) : ''), [ctx, visual]);
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
    () => (visual ? detectFallback(ctx) : { chars: [] as string[], count: 0 }),
    [ctx, visual],
  );
  const fallbackSample = fallback.chars.slice(0, 5).join(' ') + (fallback.chars.length > 5 ? ' …' : '');

  const multiSheet = doc.sheets.length > 1;
  const format = FORMATS.find((item) => item.id === options.format) ?? FORMATS[0]!;

  // 预览内容：md / opml 是字符串，xmind 是大纲，其余是一张图。三者互斥。
  const previewText = textContent ?? xmindPreview?.text ?? null;

  // 位图的输出像素尺寸。SVG 没有这个上限——它是矢量的，再大也只是字符串长一点。
  const outputWidth = Math.round(ctx.width * ctx.scale);
  const outputHeight = Math.round(ctx.height * ctx.scale);
  // 只有 PNG / JPEG 需要过尺寸闸门。文本格式若也走一遍，一张巨型导图会被判成
  // 「太大」并把「下载」按钮禁掉——导个 Markdown 而已。
  // PDF 也走位图：它内部嵌的就是一张 JPEG，同样受浏览器尺寸闸门约束。
  const needsRaster = options.format === 'png' || options.format === 'jpeg' || options.format === 'pdf';
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
  const branches = useMemo(() => (visual ? planBranches(doc, sheetId) : []), [doc, sheetId, visual]);

  // 画布范围对「图」与 `.xmind` 都有效（`.xmind` 一个文件能装多张画布），
  // 只有 md / opml 不适用——那两个序列化器一次只吃一张。所以它单独拎出来，
  // 在两个分支里各放一次，而不是复制一份 JSX。
  const scopeField = (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1 text-xs font-semibold text-foreground">
        {t('editor.export.scope')}
      </legend>
      <RadioGroup
        label={t('editor.export.scope')}
        value={options.scope}
        options={[
          { value: 'current', label: t('editor.export.scopeCurrent') },
          // 只有一张画布时「全部」与「当前」等价，禁用比让人选一个没差别的
          // 选项更诚实。
          {
            value: 'all',
            label: t('editor.export.scopeAll', { count: doc.sheets.length }),
            disabled: !multiSheet,
          },
        ]}
        onChange={(scope) => patch({ scope })}
      />
    </fieldset>
  );

  const download = async () => {
    if (textContent !== null) {
      // 文本是同步生成的字符串，没有异步失败路径，所以不必包 try/catch。
      // 带上 charset：不带的话 Windows 上的编辑器会按 GBK 打开，中文全成乱码。
      const blob = new Blob([textContent], { type: format.mime ?? 'text/plain;charset=utf-8' });
      downloadBlob(blob, exportFileName(ctx.title, format.ext));
      onClose();
      return;
    }

    if (options.format === 'xmind') {
      // 打包是同步的纯计算（fflate 的 `zipSync`），但仍然放在 `busy` 里：
      // 一张几百节点的图加上内嵌图片要几百毫秒，期间按钮必须变成「正在生成」，
      // 否则用户会连点。
      setBusy(true);
      try {
        const result = buildXmind(doc, baseCtx, dataUrls);
        downloadBlob(
          new Blob([result.bytes as BlobPart], { type: 'application/zip' }),
          exportFileName(ctx.title, format.ext),
        );
        onClose();
      } catch {
        toast.error(t('editor.export.failedXmind'));
      } finally {
        setBusy(false);
      }
      return;
    }

    if (split && branches.length > 1) {
      setBusy(true);
      try {
        const rasterFormat = options.format === 'png' ? 'png' : 'jpeg';
        const result = await exportBranches(doc, sheetId, options, format.ext, {
          // 图片内嵌对拆分同样有效：每张分支图也要把 `/uploads/…` 换成 data URL，
          // 否则打出来的 zip 里全是指回本机的死链。
          //
          // 字体同理，而且这里用的是**整份文档**算出来的那份 CSS：每个分支的文字
          // 都是它的子集，覆盖面只多不少。逐分支重算要多读几次分片，收益只是
          // 每个文件小一点点——分支图本来就要发给别人，宁可多带几十 KB。
          prepare: (raw) => applyFontCss(applyImageSources(raw, dataUrls), fontCss),
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
                  const bytes = new Uint8Array(await blob.arrayBuffer());
                  // 拆分出的每个分支都是一份独立文件，所以每份都要有自己的
                  // 页面尺寸与标题——用整份文档的标题会让 zip 里出现 N 个同名文件。
                  return options.format === 'pdf'
                    ? toPdf(bytes, raw.title, raw.width, raw.height)
                    : bytes;
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
        // PDF 内部嵌 JPEG：省掉一次「PNG → 再压缩」的往返，也避免 PDF 里
        // 出现需要单独处理的 alpha 通道。
        format: options.format === 'png' ? 'png' : 'jpeg',
        background: ctx.background,
      });
      if (options.format === 'pdf') {
        const bytes = toPdf(new Uint8Array(await blob.arrayBuffer()), ctx.title, ctx.width, ctx.height);
        downloadBlob(new Blob([bytes as BlobPart], { type: 'application/pdf' }), exportFileName(ctx.title, 'pdf'));
      } else {
        downloadBlob(blob, exportFileName(ctx.title, format.ext));
      }
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
                : xmindPreview !== null
                  // `.xmind` 没有「尺寸」可言：报节点数才是用户关心的
                  //（「我这张图有多少个主题」）。
                  ? t('editor.export.xmindSize', { count: xmindPreview.topics })
                  : split && branches.length > 1
                    // 拆分时逐张尺寸不同，报一个数只会误导；报文件数才有用。
                    ? t('editor.export.splitFiles', { count: branches.length })
                    : options.format === 'pdf'
                      ? // PDF 的「尺寸」用户是按纸看的：报像素没有意义。
                        t('editor.export.pageSize', {
                          width: mmOf(ctx.width),
                          height: mmOf(ctx.height),
                        })
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
            {/* 字体真的嵌进去了才提体积。半兆以下不必打扰——内嵌是默认行为，
                每次都报一句「我嵌了字体」只会变成噪音。 */}
            {fontCss.length > FONT_SIZE_HINT_BYTES ? (
              <span className="ml-2 text-muted-foreground">
                {t('editor.export.fontEmbedded', {
                  size: `${Math.round(fontCss.length / 1024)} KB`,
                  count: fontFaces,
                })}
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
            文本格式与 xmind 换成等宽文本——那两种格式没有「画出来」的样子，
            画一张图反而是骗人。 */}
        <div
          className={`flex max-h-[52vh] min-h-40 flex-1 overflow-auto rounded-xl border border-border p-3 ${
            previewText === null ? 'items-center justify-center' : 'items-start justify-start'
          }`}
          style={
            previewText !== null
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
          {previewText === null ? (
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
              {previewText}
            </pre>
          )}
        </div>

        <div className="flex w-full shrink-0 flex-col gap-3 sm:w-52">
          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1 text-xs font-semibold text-foreground">
              {t('editor.export.format')}
            </legend>
            <RadioGroup
              label={t('editor.export.format')}
              value={options.format}
              options={FORMATS.map((item) => ({ value: item.id, label: t(item.labelKey) }))}
              onChange={(format) => patch({ format })}
            />
          </fieldset>

          {visual ? (
            <>
              {scopeField}

              <label className="flex flex-col gap-1 text-xs font-semibold text-foreground">
                {t('editor.export.scale')}
                <div className="flex items-center gap-1.5">
                  <Select
                    aria-label={t('editor.export.scale')}
                    size="sm"
                    className="min-w-0 flex-1"
                    value={customScale ? 'custom' : String(options.scale)}
                    options={[
                      ...SCALES.map((scale) => ({
                        value: String(scale),
                        label: t('editor.export.scaleValue', { n: scale }),
                      })),
                      { value: 'custom', label: t('editor.export.scaleCustom') },
                    ]}
                    onChange={(next) => {
                      if (next === 'custom') {
                        setCustomScale(true);
                        // 保持当前倍率不动：直接跳到某个默认值会让用户以为他选的
                        // 倍率被改掉了。
                        patch({ scale: clampScale(options.scale) });
                      } else {
                        setCustomScale(false);
                        patch({ scale: Number(next) });
                      }
                    }}
                  />
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
                <Select
                  aria-label={t('editor.export.padding')}
                  size="sm"
                  value={String(options.padding)}
                  options={PADDINGS.map((padding) => ({
                    value: String(padding),
                    label: padding === 0 ? t('editor.export.paddingNone') : `${padding}px`,
                  }))}
                  onChange={(next) => patch({ padding: Number(next) })}
                />
              </label>

              <label className="flex flex-col gap-1 text-xs font-semibold text-foreground">
                {t('editor.export.aspect')}
                <Select
                  aria-label={t('editor.export.aspect')}
                  size="sm"
                  value={options.aspect}
                  options={ASPECT_ORDER.map((id) => ({ value: id, label: t(ASPECT_LABELS[id]) }))}
                  onChange={(aspect) => patch({ aspect })}
                />
              </label>

              <label className="flex flex-col gap-1 text-xs font-semibold text-foreground">
                {t('editor.export.border')}
                <Select
                  aria-label={t('editor.export.border')}
                  size="sm"
                  value={options.border}
                  options={BORDER_ORDER.map((id) => ({ value: id, label: t(BORDER_LABELS[id]) }))}
                  onChange={(next) => {
                    // 带底色的预设与「透明背景」互斥：选中时顺手把透明关掉，
                    // 免得留下「勾着透明却是绿底」这种自相矛盾的状态。
                    patch({ border: next, ...(presetHasFill(next) ? { transparent: false } : {}) });
                  }}
                />
              </label>

              <div className="flex flex-col gap-1.5">
                {([
                  ['transparent', t('editor.export.transparent')],
                  ['date', t('editor.export.date')],
                  ['brand', t('editor.export.brand')],
                ] as const).map(([key, label]) => (
                  <Checkbox
                    key={key}
                    label={label}
                    checked={options[key]}
                    // 带底色的预设自带背景，透明背景在这时没有意义。
                    disabled={key === 'transparent' && presetHasFill(options.border)}
                    onCheckedChange={(checked) => patch({ [key]: checked })}
                  />
                ))}
                {/* 品牌文字：默认套用站点设置，但允许当场改——同一份图可能要发给
                    两个客户，各自落款不同。只勾了「品牌标识」才出现，否则屏幕上
                    会多一个永远用不到的输入框。 */}
                {options.brand ? (
                  <label className="flex flex-col gap-1 pl-6 text-[11px] font-normal text-muted-foreground">
                    {t('editor.export.brandText')}
                    <input
                      type="text"
                      value={options.brandText}
                      // 与后端 `site.brand` 的 64 字符上限对齐：前端不拦，用户会
                      // 敲出一行把页脚撑满的字，导出后才发现右下角糊成一片。
                      maxLength={64}
                      onChange={(event) => {
                        brandTouched.current = true;
                        patch({ brandText: event.target.value });
                      }}
                      placeholder={siteBrand}
                      className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs text-foreground"
                    />
                  </label>
                ) : null}
                {options.format === 'jpeg' && options.transparent ? (
                  // 勾着「透明背景」却导 JPEG，预览里是白底——不解释一句，用户会以为
                  // 透明选项失效了。
                  <p className="text-[11px] leading-snug text-amber-600 dark:text-amber-400">
                    {t('editor.export.jpegOpaque')}
                  </p>
                ) : null}
                {/* 只有一个分支时拆分没有意义：拆出来就是整张图。 */}
                {branches.length > 1 ? (
                  <Checkbox
                    label={t('editor.export.split', { count: branches.length })}
                    checked={split}
                    onCheckedChange={setSplit}
                  />
                ) : null}
              </div>
            </>
          ) : plainText ? (
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
          ) : (
            // xmind 是「结构」格式，倍率/留白/边框同样不适用；但画布范围适用
            // （一个 .xmind 能装多张画布），所以这里保留范围选择器。
            <div className="flex flex-col gap-3">
              {scopeField}
              <p className="rounded-lg border border-border bg-muted/40 px-2.5 py-2 text-[11px] leading-snug text-muted-foreground">
                {t('editor.export.xmindNote')}
              </p>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
