/**
 * 导出时的图片内嵌。
 *
 * 导出的 SVG 是**独立文件**：用户会把它拖进 Keynote、发到群里、放进邮件附件。
 * 而节点图片的 `src` 有两种「只在应用内有效」的形态——`/uploads/file_xxx.png`
 * 这种同源相对路径，和 `https://…` 这种外链。前者离开站点就是死链，后者在
 * 断网的接收方那里也是死链。
 *
 * 所以导出前要把它们换成 `data:` URL。这一步是**异步**的（要读字节），而
 * `buildExportSvg` 是同步的（`renderToStaticMarkup`），两者用一个「地址映射表」
 * 接起来：
 *
 * 1. `collectImageSources(ctx)` —— 纯函数，列出所有需要内嵌的地址；
 * 2. `loadImageSources(sources)` —— 异步，抓字节转 base64，失败的**不写进表**；
 * 3. `applyImageSources(ctx, map)` —— 纯函数，换掉 `sizes` 里的 `src`。
 *
 * 拆成三步而不是一个 `await inlineAll(ctx)`：对话框每次改选项都要重算一遍
 * SVG（`useMemo` 依赖选项），如果内嵌和构建绑在一起，勾一下「边框」就会重新
 * 下载所有图片。分开之后，映射表只在图片集合变化时才变，重算 SVG 是纯内存操作。
 */

import type { LayoutResult } from '../layout/types';
import type { ExportContext, ExportSheet } from './context';

/** 抓一张图，返回 `data:` URL；拿不到就返回 `null`（不抛）。 */
export type ImageFetcher = (src: string) => Promise<string | null>;

/**
 * 已经内嵌过的地址。
 *
 * 模块级缓存而不是挂在对话框上：同一张图在「当前画布 → 全部画布 → 改倍率」
 * 之间会被反复问到，而字节内容不会变。缓存的 key 是 `src` 本身（服务端文件名
 * 含 128 位随机串，内容与地址一一对应）。
 */
const dataUrlCache = new Map<string, string>();
/** 抓失败的地址。记下来是为了别在每次重算时再撞一次 404。 */
const failed = new Set<string>();

/** `data:` 已经是内嵌的，不需要再抓；空串表示没有图。 */
function needsFetch(src: string): boolean {
  return src !== '' && !src.startsWith('data:');
}

/** 遍历一张画布里的所有图片地址。 */
function* sheetSources(sheet: ExportSheet): Generator<string> {
  for (const size of sheet.layout.sizes.values()) {
    const src = size.image?.src;
    if (src !== undefined && needsFetch(src)) yield src;
  }
}

/**
 * 列出需要内嵌的地址（去重、保持出现顺序）。
 *
 * 去重是必需的：XMind 里复制粘贴一个带图的节点会共用同一个资源条目，一张图
 * 可能被十个节点引用，不去重就是十次下载。
 */
export function collectImageSources(ctx: ExportContext): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const sheet of ctx.sheets) {
    for (const src of sheetSources(sheet)) {
      if (seen.has(src)) continue;
      seen.add(src);
      out.push(src);
    }
  }
  return out;
}

/**
 * 单张图的抓取超时。
 *
 * 没有这个上限时，一张挂在 CDN 上、或者域名早已失效的外链图会让 `fetch`
 * 一直挂着（实测过 `https://example.com/remote.png` 在无网环境里能挂到几十秒），
 * 而导出对话框要等**所有**图片抓完才更新预览——用户看到的就是「导出按钮点了
 * 没反应」。
 */
const FETCH_TIMEOUT_MS = 8000;

/** 浏览器默认的抓取方式：`fetch` → `blob` → `FileReader.readAsDataURL`。 */
export const browserImageFetcher: ImageFetcher = async (src) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(src, { signal: controller.signal });
    if (!response.ok) return null;
    const blob = await response.blob();
    return await new Promise<string | null>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    // 跨域、断网、404、超时都走这里。返回 null 让调用方保留原地址，而不是让
    // 整个导出失败——用户宁可拿到一张少图的 SVG，也不想看到「导出失败」。
    return null;
  } finally {
    clearTimeout(timer);
  }
};

/**
 * 抓取并转换成 `data:` URL。
 *
 * 返回的表里**只有成功的**。失败的地址不在表里，`applyImageSources` 会原样
 * 保留它的 `src`：那张图在接收方那里可能是坏的，但把 `<image>` 整个删掉
 * 只会让节点里留一块空白，还看不出为什么。
 *
 * **并发**抓取，不是串行。串行时总耗时是每张图的和，而外链图一旦挂住，后面
 * 所有本来秒回的本地图都得排队等它超时；并发之后总耗时是最慢的那一张，且被
 * `FETCH_TIMEOUT_MS` 封顶。
 */
export async function loadImageSources(
  sources: readonly string[],
  fetcher: ImageFetcher = browserImageFetcher,
): Promise<Map<string, string>> {
  const unique = [...new Set(sources)];

  const settled = await Promise.all(
    unique.map(async (src): Promise<[string, string] | null> => {
      const cached = dataUrlCache.get(src);
      if (cached !== undefined) return [src, cached];
      if (failed.has(src)) return null;

      const dataUrl = await fetcher(src);
      if (dataUrl === null) {
        failed.add(src);
        return null;
      }
      dataUrlCache.set(src, dataUrl);
      return [src, dataUrl];
    }),
  );

  const out = new Map<string, string>();
  for (const entry of settled) {
    if (entry !== null) out.set(entry[0], entry[1]);
  }
  return out;
}

/** 用映射表换掉 `src`；表里没有的保持原样。没有变化时返回原对象。 */
export function applyImageSources(
  ctx: ExportContext,
  sources: ReadonlyMap<string, string>,
): ExportContext {
  let changed = false;
  const sheets = ctx.sheets.map((sheet) => {
    let sizes = sheet.layout.sizes;
    for (const [id, size] of sheet.layout.sizes) {
      const src = size.image?.src;
      if (src === undefined) continue;
      const replacement = sources.get(src) ?? withoutShareCredentials(src);
      if (replacement === src) continue;
      if (sizes === sheet.layout.sizes) sizes = new Map(sheet.layout.sizes);
      sizes.set(id, { ...size, image: { ...size.image!, src: replacement } });
      changed = true;
    }
    if (sizes === sheet.layout.sizes) return sheet;
    const layout: LayoutResult = { ...sheet.layout, sizes };
    return { ...sheet, layout };
  });

  // 引用不变时返回原对象：`useMemo` 的依赖是它，白造一个新对象会让下游
  // 每轮都重算一次。
  return changed ? { ...ctx, sheets } : ctx;
}

/** Failed embeds must not distribute a share's temporary password proof in SVG. */
export function withoutShareCredentials(src: string): string {
  if (!/^\/uploads\/file_(?:[1-9][0-9]*_)?[a-f0-9]{32}\.(?:png|jpg|gif|webp)\?/.test(src)) return src;
  const parsed = new URL(src, 'https://wmind.invalid');
  let changed = false;
  for (const key of [...parsed.searchParams.keys()]) {
    if (key.toLowerCase() === 'share' || key.toLowerCase() === 'access') {
      parsed.searchParams.delete(key);
      changed = true;
    }
  }
  return changed ? parsed.pathname + parsed.search + parsed.hash : src;
}

/** 测试用：清掉模块级缓存。 */
export function resetImageCache(): void {
  dataUrlCache.clear();
  failed.clear();
}
