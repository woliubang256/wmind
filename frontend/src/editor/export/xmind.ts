/**
 * XMind 导出。
 *
 * 写的是**现代格式**（XMind 2020+）：一个 zip，里面 `content.json` 装全部画布，
 * `metadata.json` 装工作簿信息，`manifest.json` 列条目，图片进 `resources/`。
 * 不写 XMind 8 的 `content.xml`：那是另一套 schema（XML + `styles.xml` 引用），
 * 维护两份写入器的成本换不来什么——XMind 2020 之后的版本都能打开 `content.json`。
 *
 * 四条贯穿全文件的决定：
 *
 * 1. **样式写解析后的值，不写「继承」**。XMind 的主题体系与本项目完全不同，
 *    留着 `null` 让 XMind 套它自己的主题，导出的图会从彩色变成一片灰白——
 *    而用户导出是为了给别人看「我画的这张图」。所以每个主题都写 `layout.styles`
 *    里已经算好的 `ComputedStyle`：形状、填充、文字色、字号、边框、连线。
 *    代价是导出后在 XMind 里换主题不会生效（每项都是显式值），这是刻意的取舍。
 * 2. **不写 `fo:font-family`**。本项目存的是族标识符（`sans` / `serif` / `mono`），
 *    不是字体名。硬猜一个字体名（`NeverMind`、`Microsoft YaHei`）会写出一个在
 *    对方机器上未必存在的引用；而导入侧的 `normalizeFontFamily` 又会把它降级并
 *    报一条警告——「导出再导入」反而比不写更吵。留空由 XMind 决定更诚实。
 * 3. **概要挂在父主题上、外框挂在「共同父主题」上、联系挂在画布上**。这是 XMind
 *    自己的位置。写在画布级也能被本项目读回来，但 XMind 打开时未必认得。
 * 4. **图片必须内嵌**。节点图片的 `src` 可能是 `/uploads/…`（只在站内有效）或外链
 *    （随时失效）。调用方先把它们换成 `data:` URL，这里解出字节写进
 *    `resources/`，`src` 写成 `xap:resources/<name>`。换不回来的图**不写**，
 *    由调用方如实计数——写一个指回本机的地址，文件到了别人手里就是一张破图。
 */

import { zipSync } from 'fflate';
import type {
  ComputedStyle,
  LineStyle,
  ShapeClass,
  Sheet,
  StructureClass,
  Summary,
  Theme,
  Topic,
  WmindDocument,
} from '../model/types';
import { collectBoundaries, collectSummaries } from '../model/traverse';
import { relationshipStyle } from '../layout/annotations';
import type { ExportContext } from './context';

// ---------------------------------------------------------------------------
// 枚举反查
// ---------------------------------------------------------------------------

/** 本项目结构 → XMind `structureClass`。`import/xmind/mapping.ts` 的逆表。 */
const STRUCTURE_CLASS: Record<StructureClass, string> = {
  mindmap: 'org.xmind.ui.map.unbalanced',
  'logic-right': 'org.xmind.ui.logic.right',
  'logic-left': 'org.xmind.ui.logic.left',
  'org-chart': 'org.xmind.ui.org-chart.down',
  'tree-right': 'org.xmind.ui.tree.right',
  timeline: 'org.xmind.ui.timeline',
  fishbone: 'org.xmind.ui.fishbone.leftHeaded',
  brace: 'org.xmind.ui.brace.right',
  'tree-table': 'org.xmind.ui.spreadsheet',
};

/** 本项目形状 → XMind `shape-class`。 */
const SHAPE_CLASS: Record<ShapeClass, string> = {
  rect: 'org.xmind.ui.rect',
  'rounded-rect': 'org.xmind.ui.roundedRect',
  capsule: 'org.xmind.ui.capsule',
  ellipse: 'org.xmind.ui.ellipse',
  circle: 'org.xmind.ui.circle',
  diamond: 'org.xmind.ui.diamond',
  hexagon: 'org.xmind.ui.hexagon',
  parallelogram: 'org.xmind.ui.parallelogram',
  underline: 'org.xmind.ui.underline',
  none: 'org.xmind.ui.none',
};

/**
 * 本项目连线样式 → XMind `border-line-pattern`。
 *
 * `elbow` 写 `dash`：导入侧把 `dash` / `dot` 都读成 `elbow`（本项目没有虚线分支线，
 * 取几何形状最接近的那个）。反过来写 `dash` 至少能让「不是直线」这件事表达出来。
 */
const LINE_PATTERN: Record<LineStyle, string> = {
  straight: 'solid',
  curve: 'curve',
  elbow: 'dash',
  none: 'none',
};

// ---------------------------------------------------------------------------
// 样式
// ---------------------------------------------------------------------------

/** 保留两位小数，去掉浮点尾巴（`22.500000000000004` 会让 JSON 很难看）。 */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * `ComputedStyle` → XMind `style.properties`。
 *
 * 键名与 `import/xmind/style.ts` 的读取表逐条对应——那边读什么，这边就写什么，
 * 两处不同步时「导出再导入」会静默丢字段。
 *
 * 字号要换成 **pt**：XMind 用 pt，本项目用 px，导入侧按 `×4/3` 换算。写 px 出去
 * 会被当成 pt 再乘一遍，字号直接涨三分之一。
 */
function styleProperties(style: ComputedStyle): Record<string, string> {
  return {
    'shape-class': SHAPE_CLASS[style.shape],
    'svg:fill': style.fill ?? 'none',
    'svg:fill-pattern': style.fillPattern,
    'line-color': style.borderColor,
    'line-width': String(style.borderWidth),
    'line-pattern': style.borderStyle,
    'fo:font-size': `${round2(style.fontSize * 0.75)}pt`,
    'fo:font-weight': String(style.fontWeight),
    'fo:font-style': style.fontStyle,
    'fo:color': style.textColor,
    'fo:text-decoration': style.textDecoration,
    'fo:text-align': style.textAlign,
    'border-line-color': style.lineColor,
    'border-line-width': String(style.lineWidth),
    'border-line-pattern': LINE_PATTERN[style.lineStyle],
  };
}

// ---------------------------------------------------------------------------
// 图片
// ---------------------------------------------------------------------------

interface ResourceBag {
  /** 包内文件名 → 字节。键形如 `resources/image-1.png`。 */
  files: Record<string, Uint8Array>;
  /** 原 `src` → 包内引用（`xap:resources/…`）。写 `image.src` 时用。 */
  refs: Map<string, string>;
  /** 拿不到 data URL 的图片数。 */
  skipped: number;
}

/** 从 `data:` URL 里取 MIME 与字节。非 data URL 或格式不认识返回 null。 */
function decodeDataUrl(url: string): { bytes: Uint8Array; ext: string } | null {
  const match = /^data:([^;,]+)(;base64)?,([\s\S]*)$/.exec(url);
  if (match === null) return null;
  const mime = (match[1] ?? '').toLowerCase();
  const ext = MIME_EXT[mime];
  if (ext === undefined) return null;

  const payload = match[3] ?? '';
  try {
    if (match[2] === ';base64') {
      const binary = atob(payload);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      return { bytes, ext };
    }
    return { bytes: new TextEncoder().encode(decodeURIComponent(payload)), ext };
  } catch {
    // base64 不合法、或百分号转义坏了：当成「这张图取不回来」。
    return null;
  }
}

/** 只认这几种：XMind 的图片节点就是位图 + SVG，别的 MIME 它不会显示。 */
const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
};

/**
 * 把一张图塞进包里，返回 `xap:` 引用；拿不到就返回 null 并记账。
 *
 * 同一张图可能被多个节点引用（复制节点时 `src` 会跟着复制），所以按 `src` 去重：
 * 一张 3MB 的截图被复制五次，不去重的话包里会有五份。
 */
function claimResource(src: string, images: ReadonlyMap<string, string>, bag: ResourceBag): string | null {
  const existing = bag.refs.get(src);
  if (existing !== undefined) return existing;

  const dataUrl = images.get(src);
  const decoded = dataUrl === undefined ? null : decodeDataUrl(dataUrl);
  if (decoded === null) {
    bag.skipped += 1;
    return null;
  }

  const name = `resources/image-${bag.refs.size + 1}.${decoded.ext}`;
  bag.files[name] = decoded.bytes;
  const ref = `xap:${name}`;
  bag.refs.set(src, ref);
  return ref;
}

// ---------------------------------------------------------------------------
// 主题
// ---------------------------------------------------------------------------

/** 把 id 数组写成 XMind 的 `"(a,b,c)"` 形式。 */
function rangeString(ids: readonly string[]): string {
  return `(${ids.join(',')})`;
}

interface TopicMaps {
  styles: ReadonlyMap<string, ComputedStyle>;
  images: ReadonlyMap<string, string>;
  bag: ResourceBag;
  /** 主题 id → 挂在它下面的概要。 */
  summaries: Map<string, Summary[]>;
  /** 子主题 id → 父主题 id。用来给外框找「共同父主题」。 */
  parentOf: Map<string, string>;
}

function topicToXmind(topic: Topic, maps: TopicMaps): Record<string, unknown> {
  const node: Record<string, unknown> = {
    id: topic.id,
    class: 'topic',
    title: topic.title,
  };

  if (topic.structure !== null) node.structureClass = STRUCTURE_CLASS[topic.structure];

  // 样式一定写：`layout.styles` 里每个节点都有算好的完整值，没有「继承」这一档。
  const style = maps.styles.get(topic.id);
  if (style !== undefined) {
    node.style = { id: `s-${topic.id}`, properties: styleProperties(style) };
  }

  if (topic.href !== '') node.href = topic.href;
  if (topic.content) node.wmindContent = topic.content;
  if (topic.collapsed) node.collapsed = true;

  const plain = topic.notes?.plain?.trim() ?? '';
  const html = topic.notes?.html ?? '';
  if (plain !== '' || html !== '') {
    // `realHTML` 是 XMind 自己的键名（不是 `html`）。写 `html` 也能被本项目读回，
    // 但 XMind 会当成未知字段——这里对齐它。
    node.notes = {
      plain: { content: plain },
      ...(html === '' ? {} : { realHTML: { content: html } }),
    };
  }

  if (topic.labels.length > 0) node.labels = topic.labels;
  if (topic.markers.length > 0) {
    // `markerId` 就是 XMind 的扁平 id（`priority-1`），导入侧据此反查分组。
    node.markers = topic.markers.map((marker) => ({ markerId: marker.markerId }));
  }

  if (topic.image !== null && topic.image.src !== '') {
    const ref = claimResource(topic.image.src, maps.images, maps.bag);
    if (ref !== null) {
      node.image = { src: ref, width: topic.image.width, height: topic.image.height };
    }
  }

  const attached = topic.children.attached.map((child) => {
    maps.parentOf.set(child.id, topic.id);
    return topicToXmind(child, maps);
  });
  // `detached` 只在根主题上出现：本项目的自由主题是画布级的一等公民，
  // 而 XMind 把它们放在 `rootTopic.children.detached`。导入侧会把它们重新
  // 提回 `sheet.floatingTopics`，所以这一处来回是闭合的。
  const detached = topic.children.detached.map((child) => {
    maps.parentOf.set(child.id, topic.id);
    return topicToXmind(child, maps);
  });

  if (attached.length > 0 || detached.length > 0) {
    node.children = {
      ...(attached.length === 0 ? {} : { attached }),
      ...(detached.length === 0 ? {} : { detached }),
    };
  }

  const summaries = maps.summaries.get(topic.id);
  if (summaries !== undefined && summaries.length > 0) {
    node.summaries = summaries.map((summary) => ({
      id: summary.id,
      class: 'summary',
      range: rangeString(summary.range),
      topicId: summary.topicId,
      ...(summary.title === '' ? {} : { title: summary.title }),
    }));
  }

  // 外框不在这里挂：归属要等整棵树的父子关系登记完才算得出来（见
  // `attachBoundaries`），这一趟走到某个节点时它的子孙还没登记。

  return node;
}

// ---------------------------------------------------------------------------
// 画布
// ---------------------------------------------------------------------------

/**
 * 给每个外框找「该挂在哪个主题下」，并顺手转成 XMind 的节点形状。
 *
 * XMind 的外框挂在**被框住的那些节点的父主题**上。本项目的 `Boundary` 只记
 * `range`，父主题要靠 `parentOf` 反查。范围跨了不同父节点时（拖选多个分支）
 * 退回根主题——XMind 那边框仍然画得出来，只是归属粗一档。
 */
function groupBoundaries(
  sheet: Sheet,
  parentOf: ReadonlyMap<string, string>,
  rootId: string,
): Map<string, Record<string, unknown>[]> {
  const out = new Map<string, Record<string, unknown>[]>();
  for (const boundary of collectBoundaries(sheet)) {
    const parents = new Set(boundary.range.map((id) => parentOf.get(id) ?? rootId));
    const owner = parents.size === 1 ? [...parents][0] ?? rootId : rootId;
    const list = out.get(owner) ?? [];
    list.push({
      id: boundary.id,
      class: 'boundary',
      range: rangeString(boundary.range),
      ...(boundary.title === '' ? {} : { title: boundary.title }),
    });
    out.set(owner, list);
  }
  return out;
}

function groupSummaries(sheet: Sheet): Map<string, Summary[]> {
  const out = new Map<string, Summary[]>();
  for (const summary of collectSummaries(sheet)) {
    const list = out.get(summary.topicId) ?? [];
    list.push(summary);
    out.set(summary.topicId, list);
  }
  return out;
}

function sheetToXmind(
  sheet: Sheet,
  theme: Theme,
  styles: ReadonlyMap<string, ComputedStyle>,
  images: ReadonlyMap<string, string>,
  bag: ResourceBag,
): Record<string, unknown> {
  // 自由主题挂在根主题的 `detached` 下。这里先把它们塞进一份**浅拷贝**的根主题，
  // 不能直接改文档里的对象——导出不该留下副作用。
  const parentOf = new Map<string, string>();
  for (const floating of sheet.floatingTopics) parentOf.set(floating.id, sheet.rootTopic.id);

  const maps: TopicMaps = {
    styles,
    images,
    bag,
    summaries: groupSummaries(sheet),
    parentOf,
  };

  const root = topicToXmind(
    {
      ...sheet.rootTopic,
      children: { attached: sheet.rootTopic.children.attached, detached: sheet.floatingTopics },
    },
    maps,
  );

  // 遍历完了，`parentOf` 齐了，再算外框归属，然后补写进对应的主题节点。
  attachBoundaries(root, groupBoundaries(sheet, parentOf, sheet.rootTopic.id));

  return {
    id: sheet.id,
    class: 'sheet',
    title: sheet.title,
    rootTopic: root,
    relationships: sheet.relationships.map((relationship) => {
      const style = relationshipStyle(theme, relationship.style);
      return {
        id: relationship.id,
        class: 'relationship',
        ...(relationship.routing ? { wmindRouting: relationship.routing } : {}),
        end1Id: relationship.end1Id,
        end2Id: relationship.end2Id,
        ...(relationship.title === '' ? {} : { title: relationship.title }),
        style: { properties: {
          'border-line-color': style.lineColor,
          'border-line-width': String(style.lineWidth),
          'border-line-pattern': LINE_PATTERN[style.lineStyle],
          'line-pattern': style.borderStyle,
          'line-start-marker': style.lineStart,
          'line-end-marker': style.lineEnd,
        } },
      };
    }),
  };
}

/**
 * 把外框数组补进已经建好的主题节点树。
 *
 * 单独走一趟而不是在 `topicToXmind` 里做：外框归属要等**整棵树**的父子关系都
 * 登记完才算得出来，而递归是自顶向下的，走到某个节点时它的子孙还没登记。
 */
function attachBoundaries(node: Record<string, unknown>, boundaries: Map<string, Record<string, unknown>[]>): void {
  const id = node.id;
  if (typeof id === 'string') {
    const list = boundaries.get(id);
    if (list !== undefined && list.length > 0) node.boundaries = list;
  }
  const children = node.children;
  if (children === null || typeof children !== 'object') return;
  for (const key of ['attached', 'detached'] as const) {
    const group = (children as Record<string, unknown>)[key];
    if (!Array.isArray(group)) continue;
    for (const child of group) {
      if (child !== null && typeof child === 'object') {
        attachBoundaries(child as Record<string, unknown>, boundaries);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

export interface XmindExportResult {
  bytes: Uint8Array;
  /** 写进包里的主题数（含自由主题）。 */
  topics: number;
  /** 写进 `resources/` 的图片张数。 */
  images: number;
  /** 取不到图片数据的张数——它们没进包，调用方要如实提示。 */
  skippedImages: number;
}

const encoder = new TextEncoder();

/** 紧凑 JSON 字节：XMind 自己也不缩进，缩进只让文件大两倍。 */
function jsonBytes(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

/**
 * 生成 `.xmind` 字节。
 *
 * `ctx` 已经按 `scope` 选好了画布（`buildExportContext` 做的），所以「只导当前
 * 画布」与「导出全部」在这里不需要再判断一次。
 */
export function buildXmind(
  document: WmindDocument,
  ctx: ExportContext,
  images: ReadonlyMap<string, string>,
): XmindExportResult {
  const bag: ResourceBag = { files: {}, refs: new Map(), skipped: 0 };

  const sheets = ctx.sheets.map((item) =>
    sheetToXmind(item.sheet, item.theme, item.layout.styles, images, bag),
  );

  const topics = countTopics(ctx);

  const metadata = {
    // XMind 靠 `creator` 判断是不是自己写的；写 wmind 既诚实又不影响打开。
    creator: { name: 'wmind', version: document.formatVersion },
    activeSheetId: ctx.sheets[0]?.id ?? '',
    // 这两项声明「按新版数据结构与布局引擎写」，缺了 XMind 会走兼容路径。
    dataStructureVersion: '2',
    layoutEngineVersion: '3',
  };

  const files: Record<string, Uint8Array> = {
    'content.json': jsonBytes(sheets),
    'metadata.json': jsonBytes(metadata),
    'manifest.json': jsonBytes({
      'file-entries': {
        'content.json': {},
        'metadata.json': {},
        ...Object.fromEntries(Object.keys(bag.files).map((name) => [name, {}])),
      },
    }),
    ...bag.files,
  };

  return {
    bytes: zipSync(files, { level: 6 }),
    topics,
    images: Object.keys(bag.files).length,
    skippedImages: bag.skipped,
  };
}

function countTopics(ctx: ExportContext): number {
  let total = 0;
  const walk = (topic: Topic) => {
    total += 1;
    for (const child of topic.children.attached) walk(child);
  };
  for (const item of ctx.sheets) {
    walk(item.sheet.rootTopic);
    total += item.sheet.floatingTopics.length;
  }
  return total;
}

/**
 * 导出预览的文本大纲。
 *
 * 给对话框里那块 `<pre>` 用。**不是** Markdown：把 `.xmind` 的预览画成 Markdown
 * 会让人以为导出的就是 Markdown。只列标题与层级，外加画布名——这正是文件里
 * 能被 XMind 读出来的骨架。
 */
export function xmindOutline(ctx: ExportContext): { text: string; topics: number } {
  const lines: string[] = [];
  let topics = 0;

  const walk = (topic: Topic, depth: number) => {
    topics += 1;
    lines.push(`${'  '.repeat(depth)}${depth === 0 ? '' : '· '}${topic.title || '—'}`);
    for (const child of topic.children.attached) walk(child, depth + 1);
  };

  for (const item of ctx.sheets) {
    if (ctx.sheets.length > 1) {
      if (lines.length > 0) lines.push('');
      lines.push(`[${item.title}]`);
    }
    walk(item.sheet.rootTopic, 0);
    for (const floating of item.sheet.floatingTopics) walk(floating, 1);
  }

  return { text: lines.join('\n'), topics };
}
