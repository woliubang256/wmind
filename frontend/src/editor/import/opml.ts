/**
 * OPML 导入（docs/03 §5.4、docs/06 §2.3）。
 *
 * OPML 是这几种格式里最规整的：`<outline>` 递归就是树，属性就是字段。所以
 * 这个文件里几乎没有「判断」，全是映射。
 *
 * 两个必须处理的现实情况：
 *
 * - `<outline>` 可能有 0 个、1 个或多个。多个时第一个是中心主题，其余是
 *   **自由主题**（docs/06 §2.3）——不是丢弃，也不是硬塞成子节点。
 * - 属性可以写成 `text` 或 `title`，两个都可能缺。缺了就写 `(未命名)`，
 *   因为「空标题节点」在画布上是一个看不见的空框，比占位符更让人困惑。
 */

import { createTopic, defaultTheme } from '../model/create';
import { FORMAT_TAG, FORMAT_VERSION } from '../model/types';
import type { Marker, Topic, WmindDocument } from '../model/types';
import { mapMarker } from './markers';
import type { ImportContext } from './types';
import { parseXml, childNamed, childrenNamed, type XmlElement } from './xml';

const UNTITLED = '(未命名)';

/**
 * 按名字取子元素，**忽略大小写**（实现见 `xml.ts`）。
 *
 * XML 本身区分大小写，`xml.ts` 的 `childOf` 也严格比对；但存量 OPML 里确实
 * 有老导出器写 `<OPML><BODY><OUTLINE>`。放宽的代价只是多认几个元素，收益是
 * 这类文件不会变成「空文档」。
 */

/** OPML `_status` → 任务标记。 */
const STATUS_MARKERS: Record<string, string> = {
  done: 'task-done',
  started: 'task-start',
  paused: 'task-pause',
  canceled: 'task-cancel',
  cancelled: 'task-cancel',
};

function attr(element: XmlElement, name: string): string {
  return element.attrs[name] ?? '';
}

/**
 * 把属性里的标记类字段转成 `Marker[]`。
 *
 * `_icon` 直接当 markerId 试（OPML 的扩展约定就是写 XMind 的 markerId），
 * 认不出来就计入 `marker-unknown`——「尽力映射」不等于「静默丢弃」。
 */
function collectMarkers(element: XmlElement, ctx: ImportContext): Marker[] {
  const out: Marker[] = [];
  const push = (markerId: string) => {
    const marker = mapMarker(markerId);
    if (marker === null) {
      ctx.warn('marker-unknown', { count: 1 });
      return;
    }
    if (!out.some((item) => item.markerId === marker.markerId)) out.push(marker);
  };

  const status = attr(element, '_status').trim().toLowerCase();
  const byStatus = STATUS_MARKERS[status];
  if (byStatus !== undefined) push(byStatus);

  const priority = attr(element, '_priority').trim();
  if (/^[1-9]$/.test(priority)) push(`priority-${priority}`);

  const icon = attr(element, '_icon').trim();
  if (icon !== '') push(icon);

  return out;
}

function convertOutline(element: XmlElement, ctx: ImportContext): Topic {
  ctx.topic();
  const topic = createTopic({ id: ctx.ids.topic() });

  const text = attr(element, 'text') || attr(element, 'title');
  topic.title = ctx.title(text) || UNTITLED;

  const note = attr(element, '_note');
  if (note !== '') topic.notes.plain = note;

  const link = attr(element, '_link');
  if (link !== '') topic.href = link;

  topic.markers = collectMarkers(element, ctx);

  for (const child of childrenNamed(element, 'outline')) {
    topic.children.attached.push(convertOutline(child, ctx));
  }

  return topic;
}

export function opmlTitleFromFileName(fileName: string): string {
  const base = fileName.replace(/^.*[\\/]/, '').replace(/\.(?:opml|xml)$/i, '').trim();
  return base === '' ? UNTITLED : base;
}

function headTitle(root: XmlElement): string {
  const head = childNamed(root, 'head');
  if (head === undefined) return '';
  return (childNamed(head, 'title')?.text ?? '').trim();
}

/**
 * 解析 OPML 文本。
 *
 * XML 结构错误抛 `XmlParseError`（由适配器转成 `ImportError`）；语义上的
 * 「没有内容」（不是 opml 根、没有 body、没有 outline）返回**空 sheets**，
 * 交给框架统一判 `EMPTY_DOCUMENT`——「空」和「坏」是两种失败，判断只该在
 * 一个地方做。
 */
export function parseOpml(text: string, fileName: string, ctx: ImportContext): WmindDocument {
  const root = parseXml(text);
  const now = new Date().toISOString();

  const base: Omit<WmindDocument, 'sheets'> = {
    format: FORMAT_TAG,
    formatVersion: FORMAT_VERSION,
    id: ctx.ids.document(),
    title: headTitle(root) || opmlTitleFromFileName(fileName),
    theme: defaultTheme(),
    meta: { createdAt: now, updatedAt: now, app: 'opml' },
    extensions: [],
  };

  if (root.name.toLowerCase() !== 'opml') {
    return { ...base, sheets: [] };
  }

  const body = childNamed(root, 'body');
  const outlines = body === undefined ? [] : childrenNamed(body, 'outline');
  if (outlines.length === 0) {
    return { ...base, sheets: [] };
  }

  const [first, ...rest] = outlines;
  const rootTopic = convertOutline(first as XmlElement, ctx);
  // 多个根 outline：第一个是中心主题，其余是自由主题（docs/06 §2.3）。
  const floatingTopics = rest.map((outline) => convertOutline(outline, ctx));

  return {
    ...base,
    sheets: [
      {
        id: ctx.ids.sheet(),
        title: '画布 1',
        structure: 'mindmap',
        rootTopic,
        floatingTopics,
        relationships: [],
        boundaries: [],
        summaries: [],
        themeOverride: null,
        extensions: [],
      },
    ],
  };
}
