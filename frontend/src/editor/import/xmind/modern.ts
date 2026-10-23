import { parseRelationshipRouting } from '../../model/relationship-routing';
/**
 * XMind 2020+ / 2021+ / 2022+ 的 `content.json` 解析。
 *
 * 这一层只做「JSON 对象 → WmindDocument」，不碰 zip：解压与安全闸门在
 * `../zip.ts`，适配器（`./index.ts`）负责把两者接起来。分开的好处是测试可以
 * 直接喂一个对象，不必为每个用例现造一个压缩包。
 *
 * 三条贯穿全文件的约定：
 *
 * 1. **所有写入文档的字符串都过 `ctx.title()`**，控制字符被清掉、超长被截断。
 * 2. **节点 id 必须自己查重**。XMind 的 id 在同一文档里可能重复（复制粘贴、
 *    合并文件都会产生），而 `parseDocument` 查重时会**换掉** id —— 那样
 *    `relationships` / `boundaries` 里的引用就全指向不存在的老 id 了。所以这里
 *    先建 `原 id → 新 id` 映射，再拿映射去修引用。
 * 3. **`children.detached` 一律提到 `sheet.floatingTopics`**，见下面 `hoistDetached`。
 */

import { createTopic, defaultTheme } from '../../model/create';
import { FORMAT_TAG, FORMAT_VERSION } from '../../model/types';
import type {
  Boundary,
  Relationship,
  Sheet,
  StructureClass,
  Summary,
  Topic,
  TopicImage,
  WmindDocument,
} from '../../model/types';
import { sanitizeNotesHtml } from '../html';
import type { ImportContext, ImportInput } from '../types';
import { mapMarker } from '../markers';
import { claimId as claimIdShared, remapRange as remapRangeShared } from './ids';
import { imageFromSource } from './image';
import { mapStructure } from './mapping';
import { isRecord, read, type Properties } from './properties';
import { toPartialStyle } from './style';
import { toTheme } from './theme';

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * 取文本。XMind 的文本字段有三种形态：裸字符串、`{content}`、`{text}`。
 *
 * 不统一处理的话，「标题读出来是空」会表现为「导入后节点全是空白」，
 * 而文件里其实是有内容的。
 */
function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (isRecord(value)) {
    if (typeof value.content === 'string') return value.content;
    if (typeof value.text === 'string') return value.text;
  }
  return '';
}

/** 备注的两段：`plain` 是纯文本，`html` / `realHTML` 是富文本。 */
function readNotes(value: unknown): { plain: string; html: string } {
  if (!isRecord(value)) return { plain: '', html: '' };
  const plain = textOf(value.plain);
  const rich = textOf(value.html) || textOf(value.realHTML);
  return { plain, html: sanitizeNotesHtml(rich) };
}

/** 文件名去掉扩展名，作为文档标题（XMind 不存文档级标题）。 */
export function titleFromFileName(fileName: string): string {
  const base = fileName.replace(/^.*[\\/]/, '').replace(/\.(?:xmind|json)$/i, '').trim();
  return base === '' ? '未命名导图' : base;
}

// ---------------------------------------------------------------------------
// 主题 id 映射
// ---------------------------------------------------------------------------

interface SheetState {
  /** 原 id → 实际写入文档的 id。 */
  ids: Map<string, string>;
  used: Set<string>;
  /** 计数后统一出一条警告，避免 200 张图出 200 条重复警告。 */
  skippedImages: number;
  unknownMarkers: number;
  /** zip 里 `resources/` 下的图片；为空表示没有资源（或不是 zip）。 */
  resources: ReadonlyMap<string, Uint8Array>;
}

function newSheetState(resources?: ReadonlyMap<string, Uint8Array>): SheetState {
  return {
    ids: new Map(),
    used: new Set(),
    skippedImages: 0,
    unknownMarkers: 0,
    resources: resources ?? new Map(),
  };
}

/**
 * 把 XMind 的 `image` 节点变成 `TopicImage` + 待上传 asset。
 *
 * 三种 `src` 写法：`xap:resources/a.png`（包内）、`resources/a.png`（包内）、
 * `https://...`（外链）。细节在 `./image.ts`——XMind 8 从备注富文本里捞
 * 图片时走的是同一条路。
 *
 * 返回 null 表示这张图**没法还原**（条目不在包里、扩展名不支持、超过
 * `maxAssets`），调用方计入 `image-skipped`——不写一个指向 `xap:` 的坏引用。
 */
function readImage(node: Properties, ctx: ImportContext, state: SheetState): TopicImage | null {
  return imageFromSource(
    { src: textOf(read(node, 'src')), width: read(node, 'width'), height: read(node, 'height') },
    ctx,
    state.resources,
  );
}

/**
 * 分配一个文档内唯一的 id。
 *
 * 冲突时**保留第一次出现的映射**：后来的同名节点换新 id，但引用（联系、外框、
 * 概要）应该指向前者——用户拖出来的联系线连着的是先画的那个节点。
 *
 * 实现见 `./ids.ts`：XMind 8 走同一条路，两套格式的 id 语义没有区别。
 */
function claimId(raw: unknown, ctx: ImportContext, state: SheetState): string {
  return claimIdShared(raw, ctx, state.ids, state.used);
}

/** 把引用里的老 id 换成新 id；指向不存在节点的引用直接丢掉。 */
function remapRange(raw: unknown, state: SheetState): string[] {
  return remapRangeShared(raw, state.ids);
}

// ---------------------------------------------------------------------------
// Topic
// ---------------------------------------------------------------------------

/**
 * 把 `children.detached` 提到画布的自由主题里。
 *
 * 为什么不是「同名直传」：`layout/` 只遍历 `children.attached`，`detached` 里
 * 的节点**拿不到布局盒，等于不显示**。XMind 的 detached 语义就是「自由主题」，
 * 本模型有 `sheet.floatingTopics` 这个一等公民槽位，放进去既保住了内容也
 * 保住了语义。等布局支持子级 detached 时再改回来。
 */
function hoistDetached(topic: Topic, floating: Topic[]): void {
  if (topic.children.detached.length > 0) {
    floating.push(...topic.children.detached);
    topic.children.detached = [];
  }
  for (const child of topic.children.attached) hoistDetached(child, floating);
}

function convertTopic(raw: unknown, ctx: ImportContext, state: SheetState, floating: Topic[]): Topic {
  ctx.topic();
  const node: Properties = isRecord(raw) ? (raw as Properties) : {};

  const topic = createTopic({
    id: claimId(node.id, ctx, state),
    title: ctx.title(textOf(node.title)),
  });

  const structure = mapStructure(read(node, 'structureClass'));
  if (structure !== null) {
    if (structure.known) topic.structure = structure.structure;
    else {
      ctx.warn('structure-fallback', { from: read(node, 'structureClass') ?? '' });
      topic.structure = structure.structure;
    }
  }

  if (isRecord(node.style)) {
    topic.style = toPartialStyle(node.style.properties, ctx);
  }

  // XMind 用 `branch: "folded"` 表示折叠，个别版本写 `collapsed: true`。
  topic.collapsed = node.collapsed === true || read(node, 'branch') === 'folded';
  topic.href = textOf(node.href);

  topic.notes = readNotes(node.notes);

  topic.labels = asArray(node.labels)
    .map(textOf)
    .filter((label) => label !== '')
    .map((label) => ctx.title(label));

  for (const entry of asArray(node.markers)) {
    const markerId = isRecord(entry) ? read(entry as Properties, 'markerId') : textOf(entry);
    if (markerId === undefined || markerId === '') continue;
    const mapped = mapMarker(markerId);
    if (mapped === null) {
      state.unknownMarkers += 1;
      continue;
    }
    topic.markers.push(mapped);
  }

  // 图片：把 `resources/` 里对应的字节攒起来，`src` 先写原引用作占位符。
  // 上传是异步的，解析是同步的——两者之间由 `finalize.ts` 接起来。
  if (isRecord(node.image)) {
    const attached = readImage(node.image, ctx, state);
    if (attached === null) state.skippedImages += 1;
    else topic.image = attached;
  }

  const children = isRecord(node.children) ? node.children : {};
  for (const child of asArray(children.attached)) {
    topic.children.attached.push(convertTopic(child, ctx, state, floating));
  }
  for (const child of asArray(children.detached)) {
    topic.children.detached.push(convertTopic(child, ctx, state, floating));
  }

  // 子节点转完再处理引用：range 里的 id 这时才都在映射表里。
  for (const raw of asArray(node.boundaries)) {
    const boundary = convertBoundary(raw, state);
    if (boundary !== null) topic.boundaries.push(boundary);
  }
  for (const raw of asArray(node.summaries)) {
    const summary = convertSummary(raw, state, topic.id);
    if (summary !== null) topic.summaries.push(summary);
  }

  if (Array.isArray(node.extensions)) topic.extensions = node.extensions;

  return topic;
}

// ---------------------------------------------------------------------------
// 联系 / 外框 / 概要
// ---------------------------------------------------------------------------

function convertRelationship(raw: unknown, state: SheetState, ctx: ImportContext): Relationship | null {
  if (!isRecord(raw)) return null;
  const end1 = state.ids.get(read(raw as Properties, 'end1Id') ?? '');
  const end2 = state.ids.get(read(raw as Properties, 'end2Id') ?? '');
  // 端点缺失或同一个节点：联系线画不出来，留着只会让渲染层画出零长度线。
  if (end1 === undefined || end2 === undefined || end1 === end2) return null;
  const node = raw as Properties;
  return {
    id: ctx.ids.relationship(),
    end1Id: end1,
    end2Id: end2,
    title: ctx.title(textOf(node.title)),
    style: isRecord(node.style) ? toPartialStyle(node.style.properties, ctx) : null,
    ...(parseRelationshipRouting(node.wmindRouting) ? { routing: parseRelationshipRouting(node.wmindRouting) } : {}),
  };
}

function convertBoundary(raw: unknown, state: SheetState): Boundary | null {
  if (!isRecord(raw)) return null;
  const range = remapRange((raw as Properties).range, state);
  if (range.length === 0) return null;
  return {
    id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : `bnd-${range[0]}`,
    title: textOf(raw.title),
    range,
    style: null,
  };
}

function convertSummary(raw: unknown, state: SheetState, fallbackTopicId: string): Summary | null {
  if (!isRecord(raw)) return null;
  const node = raw as Properties;
  const range = remapRange(node.range, state);
  if (range.length === 0) return null;
  const topicId = state.ids.get(read(node, 'topicId') ?? '') ?? fallbackTopicId;
  const id = typeof raw.id === 'string' && raw.id !== '' ? raw.id : `sum-${range[0]}`;
  state.ids.set(id, id);
  return {
    id,
    topicId,
    range,
    title: textOf(raw.title),
    style: null,
  };
}

// ---------------------------------------------------------------------------
// Sheet
// ---------------------------------------------------------------------------

function convertSheet(
  raw: unknown,
  index: number,
  ctx: ImportContext,
  resources?: ReadonlyMap<string, Uint8Array>,
): Sheet {
  const node: Properties = isRecord(raw) ? (raw as Properties) : {};
  const state = newSheetState(resources);
  const floating: Topic[] = [];

  const rootTopic = convertTopic(node.rootTopic, ctx, state, floating);

  let structure: StructureClass = 'mindmap';
  const rawStructure = read(node, 'structureClass')
    ?? (isRecord(node.rootTopic) ? read(node.rootTopic as Properties, 'structureClass') : undefined);
  const mapped = mapStructure(rawStructure);
  if (mapped !== null) {
    structure = mapped.structure;
    if (!mapped.known) ctx.warn('structure-fallback', { from: rawStructure ?? '' });
  }

  hoistDetached(rootTopic, floating);

  const boundaries = asArray(node.boundaries)
    .map((item) => convertBoundary(item, state))
    .filter((item): item is Boundary => item !== null);

  const summaries = asArray(node.summaries)
    .map((item) => convertSummary(item, state, rootTopic.id))
    .filter((item): item is Summary => item !== null);

  const relationships = asArray(node.relationships)
    .map((item) => convertRelationship(item, state, ctx))
    .filter((item): item is Relationship => item !== null);


  if (state.skippedImages > 0) ctx.warn('image-skipped', { count: state.skippedImages });
  if (state.unknownMarkers > 0) ctx.warn('marker-unknown', { count: state.unknownMarkers });

  return {
    id: ctx.ids.sheet(),
    title: ctx.title(textOf(node.title)) || `画布 ${index + 1}`,
    structure,
    rootTopic,
    floatingTopics: floating,
    relationships,
    boundaries,
    summaries,
    themeOverride: toTheme(node.theme, ctx),
    extensions: Array.isArray(node.extensions) ? node.extensions : [],
  };
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/** `content.json` 的顶层可能是数组，也可能包一层 `content` / `sheets`。 */
export function normalizeSheets(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (isRecord(parsed)) {
    for (const key of ['content', 'sheets']) {
      const value = parsed[key];
      if (Array.isArray(value)) return value;
    }
  }
  return [];
}

/**
 * 把已经 `JSON.parse` 过的内容转成文档。
 *
 * 空内容（没有任何画布）会返回 `sheets: []`，由 `run()` 判 `EMPTY_DOCUMENT`——
 * 这里不抛错，是因为「空」和「坏」是两种失败，判断该由框架统一做。
 */
export function parseContentJson(
  content: unknown,
  fileName: string,
  ctx: ImportContext,
  /** zip 里的 `resources/` 条目。不传表示没有图片可读（如直接喂 JSON 的测试）。 */
  resources?: ReadonlyMap<string, Uint8Array>,
): WmindDocument {
  const rawSheets = normalizeSheets(content);
  const sheets = rawSheets.map((raw, index) => convertSheet(raw, index, ctx, resources));

  const now = new Date().toISOString();
  // 第一张画布的主题升为文档主题；其余画布保留自己的 themeOverride。
  // 第一张没有主题时用默认主题——`Theme` 不能为空，`parseDocument` 会据此兜底。
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

/** 供适配器判断：这个 zip 是不是现代格式。 */
export function hasModernContent(input: ImportInput): boolean {
  const zip = input.zip();
  return zip !== null && zip.has('content.json');
}
