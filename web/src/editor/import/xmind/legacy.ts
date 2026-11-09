/**
 * XMind 8（经典版）的 `content.xml` + `styles.xml` 解析。
 *
 * 与现代格式（`content.json`）的关系：**语义一样，编码方式不同**。所以
 * 结构转换（id 查重、detached 提升、range 重映射、备注清洗）全部复用
 * `./ids`、`./image`、`../html` 里的实现，这个文件只负责「XML 元素 →
 * 现代格式那套字段名」。
 *
 * 三条贯穿全文件的约定：
 *
 * 1. **元素名按本地名匹配，大小写不敏感**（`xml.ts` 的 `childNamed`）。
 *    `xhtml:div` 与 `div` 是同一件事，前缀只取决于导出器当时绑定的命名空间。
 * 2. **属性名两种拼法都认**。XMind 8 的小版本之间对同一属性用过不同名字
 *    （`fill-color` / `svg:fill`、`text-color` / `fo:color`、`style-id` /
 *    `styleId`）。只认一种，就会出现「有些文件的颜色读不出来」这种极难
 *    排查的差异。
 * 3. **样式读不出来不阻断导入**。`styles.xml` 的结构在不同版本间有差异，
 *    解析失败时降级为「只导入内容 + 默认主题」，并给一条 `styles-ignored`
 *    ——docs/06 §2.1.4 与路线图的风险表都是这么定的。
 *
 * 关于测试夹具：仓库里没有真实的 XMind 8 导出文件（M4.5 时点），夹具是按
 * 格式规范与公开的样本结构**重建**的，不是真实文件。这一点在 M4.11 验收
 * 前必须用真实样本替换，见 `.agents/notes` 里对应的说明。
 */

import { createTopic, defaultTheme } from '../../model/create';
import { FORMAT_TAG, FORMAT_VERSION } from '../../model/types';
import type {
  Boundary,
  Relationship,
  Sheet,
  StructureClass,
  Style,
  Summary,
  Theme,
  Topic,
  WmindDocument,
} from '../../model/types';
import { sanitizeNotesHtml } from '../html';
import { mapMarker } from '../markers';
import type { ImportContext } from '../types';
import { childNamed, childrenNamed, localName, parseXml, type XmlElement } from '../xml';
import { claimId, remapRange } from './ids';
import { imageFromSource } from './image';
import { mapStructure } from './mapping';
import { titleFromFileName } from './modern';
import type { Properties } from './properties';
import { toPartialStyle } from './style';

// ---------------------------------------------------------------------------
// 属性读取
// ---------------------------------------------------------------------------

/** 按本地名取属性值，忽略大小写与命名空间前缀。 */
function attr(element: XmlElement, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(element.attrs)) {
    if (localName(key).toLowerCase() === wanted) return value;
  }
  return undefined;
}

/**
 * XMind 8 的属性名 → 现代格式的键名。
 *
 * 这些别名不是猜的：`styles.xml` 里同一语义确实出现过两种拼法（老版本写
 * `fill-color`，新版本跟 SVG 靠拢写 `svg:fill`）。`toPartialStyle` 只认现代
 * 键名，所以在这里统一，而不是让映射函数同时认识两套。
 */
const KEY_ALIASES: Record<string, string> = {
  'fill-color': 'svg:fill',
  'text-color': 'fo:color',
  'font-family': 'fo:font-family',
  'font-size': 'fo:font-size',
  'font-weight': 'fo:font-weight',
  'font-style': 'fo:font-style',
  'text-decoration': 'fo:text-decoration',
  'text-align': 'fo:text-align',
};

/**
 * 分支线型类名 → `lineStyle`。
 *
 * `bight` 是 XMind 8 对「圆角折线」的拼写（是的，拼错了），语义等同折线；
 * `fold` 是更老版本的写法，同样是折线。
 */
const LINE_CLASSES: Record<string, Style['lineStyle']> = {
  'org.xmind.branchConnection.curve': 'curve',
  'org.xmind.branchConnection.straight': 'straight',
  'org.xmind.branchConnection.elbow': 'elbow',
  'org.xmind.branchConnection.bight': 'elbow',
  'org.xmind.branchConnection.fold': 'elbow',
  'org.xmind.branchConnection.none': 'none',
};

/**
 * 把一个元素上的属性收集成 `Properties`。
 *
 * 同时吃 `topic-properties` 与 `text-properties`：XMind 8 把几何与文字拆在
 * 两个元素上，缺一个就会「导入后只剩一半样式」。
 */
function collectProperties(elements: readonly XmlElement[]): Properties {
  const out: Properties = {};
  for (const element of elements) {
    for (const [rawKey, value] of Object.entries(element.attrs)) {
      const key = KEY_ALIASES[rawKey] ?? rawKey;
      if (!(key in out)) out[key] = value;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// styles.xml
// ---------------------------------------------------------------------------

export interface LegacyStyles {
  /** `style-id` → 已映射的样式片段。 */
  topics: Map<string, Partial<Style>>;
  /** `theme` id → 画布背景色（只还原得了这一项）。 */
  backgrounds: Map<string, string>;
  /** `styles.xml` 存在但读不出来。 */
  failed: boolean;
}

export function emptyStyles(): LegacyStyles {
  return { topics: new Map(), backgrounds: new Map(), failed: false };
}

/**
 * 解析 `styles.xml`。
 *
 * 结构（`urn:xmind:xmap:xmlns:style:2.0`）：
 *
 * ```
 * <xmap-styles>
 *   <styles><style id type="topic"><topic-properties/><text-properties/></style></styles>
 *   <master-styles><style id type="theme"><map-properties/></style></master-styles>
 * </xmap-styles>
 * ```
 *
 * 读不出来时返回 `failed: true`，调用方据此决定要不要给 `styles-ignored`。
 * **不抛错**：样式是装饰，缺了不该让整份导入失败。
 */
export function parseLegacyStyles(xml: string | null, ctx: ImportContext): LegacyStyles {
  const styles = emptyStyles();
  if (xml === null) return styles;

  let root: XmlElement;
  try {
    root = parseXml(xml);
  } catch {
    styles.failed = true;
    ctx.warn('styles-ignored');
    return styles;
  }

  const stylesNode = childNamed(root, 'styles');
  if (stylesNode !== undefined) {
    for (const style of childrenNamed(stylesNode, 'style')) {
      const id = attr(style, 'id');
      if (id === undefined || id === '') continue;
      // `type` 缺失时按 topic 处理：绝大多数 style 都是 topic 样式，
      // 而「多认一个」的代价只是多一条用不上的映射。
      const type = (attr(style, 'type') ?? 'topic').toLowerCase();
      if (type !== 'topic') continue;
      const properties = collectProperties(childrenNamed(style, 'topic-properties'));
      const merged = {
        ...properties,
        ...collectProperties(childrenNamed(style, 'text-properties')),
      };
      const mapped = toPartialStyle(merged, ctx);
      const lineClass = attr(childrenNamed(style, 'topic-properties')[0] ?? style, 'line-class');
      if (lineClass !== undefined) {
        const lineStyle = LINE_CLASSES[lineClass.trim()];
        if (lineStyle !== undefined) mapped.lineStyle = lineStyle;
      }
      styles.topics.set(id, mapped);
    }
  }

  const master = childNamed(root, 'master-styles');
  if (master !== undefined) {
    for (const style of childrenNamed(master, 'style')) {
      const id = attr(style, 'id');
      if (id === undefined || id === '') continue;
      const map = childNamed(style, 'map-properties');
      if (map === undefined) continue;
      const properties = collectProperties([map]);
      const background = properties['svg:fill'];
      if (typeof background === 'string' && background.trim() !== '') {
        styles.backgrounds.set(id, background.trim());
      }
    }
  }

  return styles;
}

// ---------------------------------------------------------------------------
// 备注
// ---------------------------------------------------------------------------

const VOID_TAGS = new Set(['br', 'hr', 'img']);

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(value: string): string {
  return escapeText(value).replace(/"/g, '&quot;');
}

/**
 * 把 XML 子树序列化回 HTML 片段。
 *
 * 用来把 `<notes><html><xhtml:div>…` 还原成 `notes.html`。元素名与属性名都
 * 用**本地名**输出：`xhtml:div` 变成 `div`，否则白名单清洗会把带前缀的名字
 * 当成未知标签整段丢掉。
 *
 * 已知的近似：`XmlElement` 把「文本」与「子元素」分开存，两者在原文里的
 * 先后顺序丢失了。这里按「文本在前、子元素在后」输出——XMind 的备注实际
 * 结构（外层 div 里包着一串 p）基本不受影响，而 `notes.html` 目前也没有
 * 任何地方渲染（视图层只读 `notes.plain`）。
 */
function serializeElement(element: XmlElement): string {
  const name = localName(element.name);
  const attrs = Object.entries(element.attrs)
    .map(([key, value]) => ` ${localName(key)}="${escapeAttr(value)}"`)
    .join('');
  if (VOID_TAGS.has(name.toLowerCase())) return `<${name}${attrs}/>`;
  const inner = `${escapeText(element.text)}${element.children.map(serializeElement).join('')}`;
  return `<${name}${attrs}>${inner}</${name}>`;
}

interface NotesResult {
  plain: string;
  html: string;
  /** 备注富文本里的图片，按出现顺序。 */
  images: { src: string; width?: string; height?: string }[];
}

/**
 * 读备注。
 *
 * XMind 8 的图片**只能**插在备注富文本里（它没有现代格式的 `topic.image`），
 * 所以这里顺手把 `<img>` 捞出来交给调用方提升成节点图片——白名单清洗会把
 * `<img>` 整段丢掉，不提升就等于静默丢图。
 */
function readNotes(element: XmlElement | undefined): NotesResult {
  const result: NotesResult = { plain: '', html: '', images: [] };
  if (element === undefined) return result;

  result.plain = childNamed(element, 'plain')?.text ?? '';

  const html = childNamed(element, 'html');
  if (html !== undefined) {
    result.html = sanitizeNotesHtml(html.children.map(serializeElement).join(''));
    collectImages(html, result.images);
  }
  return result;
}

function collectImages(element: XmlElement, out: { src: string; width?: string; height?: string }[]): void {
  for (const child of element.children) {
    if (localName(child.name).toLowerCase() === 'img') {
      const src = attr(child, 'src');
      if (src !== undefined && src.trim() !== '') {
        out.push({ src, width: attr(child, 'width'), height: attr(child, 'height') });
      }
    }
    collectImages(child, out);
  }
}

// ---------------------------------------------------------------------------
// 内容
// ---------------------------------------------------------------------------

interface SheetState {
  ids: Map<string, string>;
  used: Set<string>;
  skippedImages: number;
  unknownMarkers: number;
}

/** `children > topics[type]` 里的 `topic`。`type` 缺失按 attached 处理。 */
function childTopics(element: XmlElement | undefined, type: 'attached' | 'detached'): XmlElement[] {
  if (element === undefined) return [];
  const out: XmlElement[] = [];
  for (const topics of childrenNamed(element, 'topics')) {
    const kind = (attr(topics, 'type') ?? 'attached').toLowerCase();
    if (kind !== type) continue;
    out.push(...childrenNamed(topics, 'topic'));
  }
  return out;
}

/** 把 `children.detached` 提到画布的自由主题里（原因见 `modern.ts`）。 */
function hoistDetached(topic: Topic, floating: Topic[]): void {
  if (topic.children.detached.length > 0) {
    floating.push(...topic.children.detached);
    topic.children.detached = [];
  }
  for (const child of topic.children.attached) hoistDetached(child, floating);
}

function convertTopic(
  element: XmlElement,
  ctx: ImportContext,
  state: SheetState,
  styles: LegacyStyles,
  resources: ReadonlyMap<string, Uint8Array>,
  floating: Topic[],
): Topic {
  ctx.topic();

  const topic = createTopic({
    id: claimId(attr(element, 'id'), ctx, state.ids, state.used),
    title: ctx.title(childNamed(element, 'title')?.text ?? ''),
  });

  const structure = mapStructure(attr(element, 'structure-class'));
  if (structure !== null) {
    if (!structure.known) ctx.warn('structure-fallback', { from: attr(element, 'structure-class') ?? '' });
    topic.structure = structure.structure;
  }

  const styleId = attr(element, 'style-id') ?? attr(element, 'styleId');
  if (styleId !== undefined) {
    const style = styles.topics.get(styleId);
    // 引用了但查不到：说明 styles.xml 缺了或版本对不上。`styles-ignored`
    // 已经由 `parseLegacyStyles` 在整体失败时给过，这里不再逐节点刷屏。
    if (style !== undefined) topic.style = style;
  }

  topic.collapsed = (attr(element, 'branch') ?? '').toLowerCase() === 'folded';
  topic.href = attr(element, 'href') ?? '';

  const notes = readNotes(childNamed(element, 'notes'));
  topic.notes = { plain: notes.plain, html: notes.html };

  // 图片：备注里的第一张提升为节点图片，其余计入「未能还原」。
  if (notes.images.length > 0) {
    const [first, ...rest] = notes.images;
    const attached = first === undefined ? null : imageFromSource(first, ctx, resources);
    if (attached === null) state.skippedImages += notes.images.length;
    else {
      topic.image = attached;
      state.skippedImages += rest.length;
    }
  }

  const labels = childNamed(element, 'labels');
  if (labels !== undefined) {
    topic.labels = childrenNamed(labels, 'label')
      .map((label) => ctx.title(label.text))
      .filter((label) => label !== '');
  }

  const markerRefs = childNamed(element, 'marker-refs');
  if (markerRefs !== undefined) {
    for (const ref of childrenNamed(markerRefs, 'marker-ref')) {
      const markerId = attr(ref, 'marker-id');
      if (markerId === undefined || markerId === '') continue;
      const mapped = mapMarker(markerId);
      if (mapped === null) {
        state.unknownMarkers += 1;
        continue;
      }
      topic.markers.push(mapped);
    }
  }

  const children = childNamed(element, 'children');
  for (const child of childTopics(children, 'attached')) {
    topic.children.attached.push(convertTopic(child, ctx, state, styles, resources, floating));
  }
  for (const child of childTopics(children, 'detached')) {
    topic.children.detached.push(convertTopic(child, ctx, state, styles, resources, floating));
  }

  // XMind 8 的外框与概要挂在 sheet 上，但个别版本也写在 topic 里。两处都收。
  for (const boundary of convertBoundaries(childNamed(element, 'boundaries'), state)) {
    topic.boundaries.push(boundary);
  }
  for (const summary of convertSummaries(childNamed(element, 'summaries'), state, topic.id)) {
    topic.summaries.push(summary);
  }

  return topic;
}

function convertBoundaries(element: XmlElement | undefined, state: SheetState): Boundary[] {
  if (element === undefined) return [];
  const out: Boundary[] = [];
  for (const raw of childrenNamed(element, 'boundary')) {
    const range = remapRange(attr(raw, 'range'), state.ids);
    if (range.length === 0) continue;
    out.push({
      id: attr(raw, 'id') ?? `bnd-${range[0]}`,
      title: childNamed(raw, 'title')?.text ?? '',
      range,
      style: null,
    });
  }
  return out;
}

function convertSummaries(
  element: XmlElement | undefined,
  state: SheetState,
  fallbackTopicId: string,
): Summary[] {
  if (element === undefined) return [];
  const out: Summary[] = [];
  for (const raw of childrenNamed(element, 'summary')) {
    const range = remapRange(attr(raw, 'range'), state.ids);
    if (range.length === 0) continue;
    const own = childNamed(raw, 'topic');
    const topicId = state.ids.get(attr(raw, 'topic-id') ?? '') ?? fallbackTopicId;
    const id = attr(raw, 'id') ?? `sum-${range[0]}`;
    state.ids.set(id, id);
    if (own && attr(own, 'id')) state.ids.set(attr(own, 'id')!, id);
    out.push({
      id,
      topicId,
      range,
      // 概要的标题就是它自带那个 topic 的 `<title>`。
      title: own === undefined ? '' : (childNamed(own, 'title')?.text ?? ''),
      style: null,
    });
  }
  return out;
}

function convertRelationships(
  element: XmlElement | undefined,
  state: SheetState,
  ctx: ImportContext,
  styles: LegacyStyles,
): Relationship[] {
  if (element === undefined) return [];
  const out: Relationship[] = [];
  for (const raw of childrenNamed(element, 'relationship')) {
    const end1 = state.ids.get(attr(raw, 'end1') ?? attr(raw, 'end1Id') ?? '');
    const end2 = state.ids.get(attr(raw, 'end2') ?? attr(raw, 'end2Id') ?? '');
    // 端点缺失或同一个节点：联系线画不出来，留着只会让渲染层画出零长度线。
    if (end1 === undefined || end2 === undefined || end1 === end2) continue;
    const styleId = attr(raw, 'style-id');
    out.push({
      id: ctx.ids.relationship(),
      end1Id: end1,
      end2Id: end2,
      title: childNamed(raw, 'title')?.text ?? '',
      style: styleId === undefined ? null : (styles.topics.get(styleId) ?? null),
    });
  }
  return out;
}

/** 画布背景色 → 主题覆盖。只还原得了这一项，其余沿用默认主题。 */
function themeOverrideOf(themeId: string | undefined, styles: LegacyStyles): Theme | null {
  if (themeId === undefined) return null;
  const background = styles.backgrounds.get(themeId);
  if (background === undefined) return null;
  const base = defaultTheme();
  return {
    ...base,
    palette: { ...base.palette, backgroundColor: background },
    global: { ...base.global, backgroundColor: background },
  };
}

function convertSheet(
  element: XmlElement,
  index: number,
  ctx: ImportContext,
  styles: LegacyStyles,
  resources: ReadonlyMap<string, Uint8Array>,
): Sheet {
  const state: SheetState = { ids: new Map(), used: new Set(), skippedImages: 0, unknownMarkers: 0 };
  const floating: Topic[] = [];

  const rootElement = childNamed(element, 'topic');
  const rootTopic = rootElement === undefined
    ? createTopic({ id: ctx.ids.topic(), title: ctx.title(childNamed(element, 'title')?.text ?? '') })
    : convertTopic(rootElement, ctx, state, styles, resources, floating);

  let structure: StructureClass = 'mindmap';
  const rawStructure = attr(element, 'structure-class')
    ?? (rootElement === undefined ? undefined : attr(rootElement, 'structure-class'));
  const mapped = mapStructure(rawStructure);
  if (mapped !== null) {
    structure = mapped.structure;
    if (!mapped.known) ctx.warn('structure-fallback', { from: rawStructure ?? '' });
  }

  hoistDetached(rootTopic, floating);

  const themeId = attr(element, 'theme');
  const themeOverride = themeOverrideOf(themeId, styles);
  if (themeId !== undefined && themeOverride === null) ctx.warn('palette-fallback');

  if (state.skippedImages > 0) ctx.warn('image-skipped', { count: state.skippedImages });
  if (state.unknownMarkers > 0) ctx.warn('marker-unknown', { count: state.unknownMarkers });

  return {
    id: ctx.ids.sheet(),
    // XMind 8 大多数版本不存画布名，只有 `<sheet title>` 或 `<title>` 两种可能。
    title: ctx.title(attr(element, 'title') ?? childNamed(element, 'title')?.text ?? '') || `画布 ${index + 1}`,
    structure,
    rootTopic,
    floatingTopics: floating,
    relationships: convertRelationships(childNamed(element, 'relationships'), state, ctx, styles),
    boundaries: convertBoundaries(childNamed(element, 'boundaries'), state),
    summaries: convertSummaries(childNamed(element, 'summaries'), state, rootTopic.id),
    themeOverride,
    extensions: [],
  };
}

/**
 * 解析 `content.xml`。
 *
 * XML 结构错误抛 `XmlParseError`（文件损坏），由适配器转成 `PARSE_FAILED`；
 * 「没有 sheet」不抛，交给框架判 `EMPTY_DOCUMENT`——「空」与「坏」是两种
 * 失败，判断该由框架统一做。
 */
export function parseContentXml(
  xml: string,
  styles: LegacyStyles,
  fileName: string,
  ctx: ImportContext,
  resources: ReadonlyMap<string, Uint8Array> = new Map(),
): WmindDocument {
  const root = parseXml(xml);

  const rawSheets = childrenNamed(root, 'sheet');
  const sheets = rawSheets.map((element, index) =>
    convertSheet(element, index, ctx, styles, resources),
  );

  const now = new Date().toISOString();
  const documentTheme = sheets[0]?.themeOverride ?? defaultTheme();

  return {
    format: FORMAT_TAG,
    formatVersion: FORMAT_VERSION,
    id: ctx.ids.document(),
    title: titleFromFileName(fileName),
    theme: documentTheme,
    sheets: sheets.map((sheet, index) => (index === 0 ? { ...sheet, themeOverride: null } : sheet)),
    meta: { createdAt: now, updatedAt: now, app: 'xmind' },
    extensions: [],
  };
}
