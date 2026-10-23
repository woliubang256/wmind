/**
 * 文档解析与归一化。
 *
 * 输入是不可信的：来自后端、来自 `.wmind` 文件、来自将来的 XMind 导入。
 * 这里的策略是**宽容 + 留痕**：
 *
 * - 结构性错误（不是对象、format 不对、major 版本更高、没有画布）抛
 *   `DocumentParseError`，调用方必须处理；
 * - 字段级错误（枚举值不认识、数字越界、颜色格式不对）**不抛错**，回退到
 *   默认值并往 `warnings` 里塞一条带路径的说明。
 *
 * 为什么字段级不抛错：`.wmind` 是长期存档格式，将来新增形状 / 字体时，
 * 老客户端打开新文件应该「少显示一点」而不是「打不开」。反过来，如果哪天
 * 真的改了 major，那是结构不兼容，必须硬失败，否则会把用户的文档截断后
 * 再保存回去——那才是真正的数据丢失。
 */

import {
  FORMAT_TAG,
  FORMAT_VERSION,
} from './types';
import type {
  Boundary,
  FillPattern,
  FontFamily,
  Marker,
  Relationship,
  Sheet,
  StructureClass,
  Style,
  Summary,
  Theme,
  Topic,
  WmindDocument,
} from './types';
import { createTopic, defaultTheme } from './create';
import { newDocumentId, newTopicId } from './ids';

export class DocumentParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocumentParseError';
  }
}

export interface ParseResult {
  document: WmindDocument;
  warnings: string[];
}

const SHAPES = [
  'rect',
  'rounded-rect',
  'capsule',
  'ellipse',
  'circle',
  'diamond',
  'hexagon',
  'parallelogram',
  'underline',
  'none',
] as const;
const FONT_FAMILIES = ['sans', 'system', 'serif', 'mono'] as const;
const BORDER_STYLES = ['solid', 'dash', 'dot', 'none'] as const;
const FILL_PATTERNS = ['solid', 'none', 'gradient'] as const;
const LINE_STYLES = ['straight', 'curve', 'elbow', 'none'] as const;
const LINE_ENDS = ['none', 'arrow', 'dot'] as const;
const TEXT_ALIGNS = ['left', 'center', 'right'] as const;
const TEXT_DECORATIONS = ['none', 'underline', 'line-through'] as const;
const FONT_STYLES = ['normal', 'italic'] as const;
const STRUCTURES = [
  'mindmap',
  'logic-right',
  'logic-left',
  'org-chart',
  'tree-right',
  'timeline',
  'fishbone',
  'brace',
  'tree-table',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function pickEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
  path: string,
  warnings: string[],
): T {
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  if (value !== undefined && value !== null) {
    warnings.push(`${path} 取值 ${JSON.stringify(value)} 不受支持，已回退为 ${fallback}`);
  }
  return fallback;
}

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const FUNC_COLOR = /^(?:rgb|rgba|hsl|hsla)\([^)]*\)$/;

function isColor(value: string): boolean {
  return HEX_COLOR.test(value) || FUNC_COLOR.test(value);
}

/** 颜色：非法值回退，`null` 原样保留（表示「无填充」这类语义）。 */
function pickColor(value: unknown, fallback: string | null, path: string, warnings: string[]): string | null {
  if (value === null) return null;
  if (typeof value === 'string' && isColor(value)) return value;
  if (value !== undefined) {
    warnings.push(`${path} 不是合法颜色，已回退`);
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// Style
// ---------------------------------------------------------------------------

/**
 * 归一化一个**部分**样式。只处理出现过的键：缺省的键表示「继承」，
 * 不能被填成默认值，否则节点样式会意外固化，换主题时失效。
 */
function parsePartialStyle(
  input: unknown,
  path: string,
  warnings: string[],
): Partial<Style> | null {
  if (!isRecord(input)) return null;
  const out: Partial<Style> = {};

  if ('shape' in input) out.shape = pickEnum(input.shape, SHAPES, 'rounded-rect', `${path}.shape`, warnings);
  if ('fill' in input) out.fill = pickColor(input.fill, null, `${path}.fill`, warnings);
  if ('fillPattern' in input) out.fillPattern = pickEnum<FillPattern>(input.fillPattern, FILL_PATTERNS, 'solid', `${path}.fillPattern`, warnings);
  if ('borderColor' in input) out.borderColor = pickColor(input.borderColor, '#000000', `${path}.borderColor`, warnings) ?? '#000000';
  if ('borderWidth' in input) out.borderWidth = clamp(asFiniteNumber(input.borderWidth, 1), 0, 24);
  if ('borderStyle' in input) out.borderStyle = pickEnum(input.borderStyle, BORDER_STYLES, 'solid', `${path}.borderStyle`, warnings);
  if ('fontFamily' in input) {
    out.fontFamily = input.fontFamily === null
      ? null
      : pickEnum<FontFamily>(input.fontFamily, FONT_FAMILIES, 'sans', `${path}.fontFamily`, warnings);
  }
  if ('fontSize' in input) out.fontSize = clamp(asFiniteNumber(input.fontSize, 14), 6, 200);
  if ('fontWeight' in input) {
    // 只允许 100 的整数倍：浏览器对 437 这种值会就近匹配，存下来没有意义，
    // 而且会让「加粗」按钮的判断逻辑变得难以预料。
    const raw = asFiniteNumber(input.fontWeight, 400);
    out.fontWeight = clamp(Math.round(raw / 100) * 100, 100, 900);
  }
  if ('fontStyle' in input) out.fontStyle = pickEnum(input.fontStyle, FONT_STYLES, 'normal', `${path}.fontStyle`, warnings);
  if ('textDecoration' in input) out.textDecoration = pickEnum(input.textDecoration, TEXT_DECORATIONS, 'none', `${path}.textDecoration`, warnings);
  if ('textColor' in input) out.textColor = pickColor(input.textColor, '#000000', `${path}.textColor`, warnings) ?? '#000000';
  if ('textAlign' in input) out.textAlign = pickEnum(input.textAlign, TEXT_ALIGNS, 'center', `${path}.textAlign`, warnings);
  if ('width' in input) out.width = clamp(asFiniteNumber(input.width, 160), 20, 4000);
  if ('autoWidth' in input) out.autoWidth = asBoolean(input.autoWidth, true);
  if ('lineStyle' in input) out.lineStyle = pickEnum(input.lineStyle, LINE_STYLES, 'curve', `${path}.lineStyle`, warnings);
  if ('lineEnd' in input) out.lineEnd = pickEnum(input.lineEnd, LINE_ENDS, 'none', `${path}.lineEnd`, warnings);
  if ('lineStart' in input) out.lineStart = pickEnum(input.lineStart, LINE_ENDS, 'none', `${path}.lineStart`, warnings);
  if ('lineWidth' in input) out.lineWidth = clamp(asFiniteNumber(input.lineWidth, 2), 0, 24);
  if ('lineColor' in input) out.lineColor = pickColor(input.lineColor, '#000000', `${path}.lineColor`, warnings) ?? '#000000';
  if ('rainbowBranch' in input) out.rainbowBranch = asBoolean(input.rainbowBranch, false);
  if ('backgroundColor' in input) out.backgroundColor = pickColor(input.backgroundColor, null, `${path}.backgroundColor`, warnings);

  return out;
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

function parseTheme(input: unknown, warnings: string[]): Theme {
  const base = defaultTheme();
  if (!isRecord(input)) return base;

  const palette = isRecord(input.palette) ? input.palette : {};
  const global = isRecord(input.global) ? input.global : {};
  const layout = isRecord(input.layout) ? input.layout : {};

  const colors = asArray(palette.colors).filter((c): c is string => typeof c === 'string' && isColor(c));
  const lineColors = asArray(palette.lineColors).filter((c): c is string => typeof c === 'string' && isColor(c));
  const rainbowColors = asArray(input.rainbowColors).filter((c): c is string => typeof c === 'string' && isColor(c));

  return {
    id: asString(input.id, base.id),
    name: asString(input.name, base.name),
    category: pickEnum(input.category, ['vivid', 'classic', 'custom'] as const, 'classic', 'theme.category', warnings),
    palette: {
      // 调色板为空会让取色 `colors[i % 0]` 得到 NaN，必须兜底到内置色板。
      colors: colors.length > 0 ? colors : [...base.palette.colors],
      lineColors: lineColors.length > 0 ? lineColors : [...base.palette.lineColors],
      backgroundColor: pickColor(palette.backgroundColor, base.palette.backgroundColor, 'theme.palette.backgroundColor', warnings) ?? base.palette.backgroundColor,
    },
    global: {
      fontFamily: pickEnum<FontFamily>(global.fontFamily, FONT_FAMILIES, base.global.fontFamily, 'theme.global.fontFamily', warnings),
      fontSize: clamp(asFiniteNumber(global.fontSize, base.global.fontSize), 6, 200),
      lineWidth: clamp(asFiniteNumber(global.lineWidth, base.global.lineWidth), 0, 24),
      backgroundColor: pickColor(global.backgroundColor, base.global.backgroundColor, 'theme.global.backgroundColor', warnings) ?? base.global.backgroundColor,
    },
    centralTopic: parsePartialStyle(input.centralTopic, 'theme.centralTopic', warnings),
    mainTopic: parsePartialStyle(input.mainTopic, 'theme.mainTopic', warnings),
    subTopic: parsePartialStyle(input.subTopic, 'theme.subTopic', warnings),
    floatingTopic: parsePartialStyle(input.floatingTopic, 'theme.floatingTopic', warnings),
    summaryTopic: parsePartialStyle(input.summaryTopic, 'theme.summaryTopic', warnings),
    boundary: parsePartialStyle(input.boundary, 'theme.boundary', warnings),
    relationship: parsePartialStyle(input.relationship, 'theme.relationship', warnings),
    rainbowBranch: asBoolean(input.rainbowBranch, base.rainbowBranch),
    rainbowColors: rainbowColors.length > 0 ? rainbowColors : [...base.rainbowColors],
    layout: {
      autoBalance: asBoolean(layout.autoBalance, base.layout.autoBalance),
      compact: asBoolean(layout.compact, base.layout.compact),
      alignSiblings: asBoolean(layout.alignSiblings, base.layout.alignSiblings),
      freeBranch: asBoolean(layout.freeBranch, base.layout.freeBranch),
      flexibleFloating: asBoolean(layout.flexibleFloating, base.layout.flexibleFloating),
      topicOverlap: asBoolean(layout.topicOverlap, base.layout.topicOverlap),
    },
  };
}

// ---------------------------------------------------------------------------
// Topic
// ---------------------------------------------------------------------------

function parseMarkers(input: unknown): Marker[] {
  return asArray(input)
    .filter(isRecord)
    .map((m) => ({ groupId: asString(m.groupId), markerId: asString(m.markerId) }))
    .filter((m) => m.groupId !== '' && m.markerId !== '');
}

function parseTopic(
  input: unknown,
  path: string,
  warnings: string[],
  seen: Set<string>,
  fallbackTitle: string,
): Topic {
  const base = createTopic({ title: fallbackTitle });
  if (!isRecord(input)) return base;

  let id = asString(input.id);
  if (id === '' || seen.has(id)) {
    // ID 冲突必须重新生成：两个节点同 id 会让「按 id 找节点」静默取到错误的那个，
    // 之后所有编辑都会改错地方。这里不抛错，因为导入外部文件时冲突是常态。
    if (id !== '') warnings.push(`${path}.id 与已有节点重复，已重新生成`);
    id = newTopicId();
  }
  seen.add(id);

  const notes = isRecord(input.notes) ? input.notes : {};
  const image = isRecord(input.image) ? input.image : null;
  const children = isRecord(input.children) ? input.children : {};

  const topic: Topic = {
    id,
    title: asString(input.title, fallbackTitle),
    titleFormat: pickEnum(input.titleFormat, ['plain', 'rich'] as const, 'plain', `${path}.titleFormat`, warnings),
    structure: input.structure === null || input.structure === undefined
      ? null
      : pickEnum<StructureClass>(input.structure, STRUCTURES, 'mindmap', `${path}.structure`, warnings),
    style: parsePartialStyle(input.style, `${path}.style`, warnings),
    collapsed: asBoolean(input.collapsed, false),
    href: asString(input.href),
    notes: {
      plain: asString(notes.plain),
      html: asString(notes.html),
    },
    labels: asArray(input.labels).filter((l): l is string => typeof l === 'string'),
    markers: parseMarkers(input.markers),
    image: image && typeof image.src === 'string' && image.src !== ''
      ? {
          src: image.src,
          width: clamp(asFiniteNumber(image.width, 120), 1, 4000),
          height: clamp(asFiniteNumber(image.height, 80), 1, 4000),
        }
      : null,
    children: { attached: [], detached: [] },
    summaries: [],
    boundaries: [],
    extensions: asArray(input.extensions),
  };

  topic.children.attached = asArray(children.attached).map((child, i) =>
    parseTopic(child, `${path}.children.attached[${i}]`, warnings, seen, ''),
  );
  topic.children.detached = asArray(children.detached).map((child, i) =>
    parseTopic(child, `${path}.children.detached[${i}]`, warnings, seen, ''),
  );

  // 概要与外框在 XMind 里挂在**主题**上（`topic.summaries` / `topic.boundaries`），
  // 画布级那一份是某些工具额外写的副本。
  //
  // 这里曾经固定写 `[]`，后果是「导入一份 XMind，概要与外框全没了」——适配器
  // 明明解析出来了，却在这一步被抹掉。而渲染与导出走的是 `collectSummaries` /
  // `collectBoundaries`，它们是**两级合并**的，所以保留主题级不会有重复问题
  //（同一个 id 只取一次）。
  //
  // 主题级的概要可以不写 `topicId`：XMind 认为「挂在哪就属于哪」，缺省就是当前
  // 主题自己。画布级那份必须显式写，否则没有挂载点。
  topic.summaries = asArray(input.summaries)
    .map((summary, i) => parseSummary(summary, i, warnings, id))
    .filter((summary): summary is Summary => summary !== null);
  topic.boundaries = asArray(input.boundaries)
    .map((boundary, i) => parseBoundary(boundary, i, warnings))
    .filter((boundary): boundary is Boundary => boundary !== null);

  return topic;
}

// ---------------------------------------------------------------------------
// Sheet 附属结构
// ---------------------------------------------------------------------------

function parseRelationship(input: unknown, index: number, warnings: string[]): Relationship | null {
  if (!isRecord(input)) return null;
  const end1 = asString(input.end1Id);
  const end2 = asString(input.end2Id);
  if (end1 === '' || end2 === '' || end1 === end2) {
    warnings.push(`relationships[${index}] 端点缺失或相同，已丢弃`);
    return null;
  }
  return {
    id: asString(input.id) || `rel-${index}`,
    end1Id: end1,
    end2Id: end2,
    title: asString(input.title),
    style: parsePartialStyle(input.style, `relationships[${index}].style`, warnings),
  };
}

function parseBoundary(input: unknown, index: number, warnings: string[]): Boundary | null {
  if (!isRecord(input)) return null;
  const range = asArray(input.range).filter((id): id is string => typeof id === 'string');
  if (range.length === 0) {
    warnings.push(`boundaries[${index}] 范围为空，已丢弃`);
    return null;
  }
  return {
    id: asString(input.id) || `bnd-${index}`,
    title: asString(input.title),
    range,
    style: parsePartialStyle(input.style, `boundaries[${index}].style`, warnings),
  };
}

function parseSummary(
  input: unknown,
  index: number,
  warnings: string[],
  /** 主题级概要的默认挂载点：XMind 不写 `topicId` 时就是所在的那个主题。 */
  fallbackTopicId = '',
): Summary | null {
  if (!isRecord(input)) return null;
  const topicId = asString(input.topicId) || fallbackTopicId;
  const range = asArray(input.range).filter((id): id is string => typeof id === 'string');
  if (topicId === '' || range.length === 0) {
    warnings.push(`summaries[${index}] 缺少挂载点或范围为空，已丢弃`);
    return null;
  }
  return {
    id: asString(input.id) || `sum-${index}`,
    topicId,
    range,
    title: asString(input.title),
    style: parsePartialStyle(input.style, `summaries[${index}].style`, warnings),
  };
}

function parseSheet(input: unknown, index: number, warnings: string[], seen: Set<string>): Sheet {
  const path = `sheets[${index}]`;
  if (!isRecord(input)) {
    warnings.push(`${path} 不是对象，已替换为空画布`);
    return {
      id: `sh-fallback-${index}`,
      title: `画布 ${index + 1}`,
      structure: 'mindmap',
      rootTopic: createTopic({ title: '中心主题' }),
      floatingTopics: [],
      relationships: [],
      boundaries: [],
      summaries: [],
      themeOverride: null,
      extensions: [],
    };
  }

  const structure = pickEnum<StructureClass>(input.structure, STRUCTURES, 'mindmap', `${path}.structure`, warnings);

  return {
    id: asString(input.id) || `sh-${index}`,
    title: asString(input.title, `画布 ${index + 1}`),
    structure,
    rootTopic: parseTopic(input.rootTopic, `${path}.rootTopic`, warnings, seen, '中心主题'),
    floatingTopics: asArray(input.floatingTopics).map((t, i) =>
      parseTopic(t, `${path}.floatingTopics[${i}]`, warnings, seen, ''),
    ),
    relationships: asArray(input.relationships)
      .map((r, i) => parseRelationship(r, i, warnings))
      .filter((r): r is Relationship => r !== null),
    boundaries: asArray(input.boundaries)
      .map((b, i) => parseBoundary(b, i, warnings))
      .filter((b): b is Boundary => b !== null),
    summaries: asArray(input.summaries)
      .map((s, i) => parseSummary(s, i, warnings))
      .filter((s): s is Summary => s !== null),
    themeOverride: input.themeOverride === null || input.themeOverride === undefined
      ? null
      : parseTheme(input.themeOverride, warnings),
    extensions: asArray(input.extensions),
  };
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/** 只做形状判断，不深校验——用于在渲染前快速排除明显不对的输入。 */
export function isWmindDocument(input: unknown): input is WmindDocument {
  return isRecord(input) && input.format === FORMAT_TAG && Array.isArray(input.sheets);
}

/**
 * 解析任意输入为文档。失败抛 `DocumentParseError`。
 *
 * 注意：**永远不要**把用户上传的 JSON 直接 `as WmindDocument`。绕过这里的
 * 后果是渲染层拿到 `undefined` 的 `children`，报错点离真正的问题十万八千里。
 */
export function parseDocument(input: unknown): ParseResult {
  if (!isRecord(input)) {
    throw new DocumentParseError('文件内容不是 JSON 对象');
  }
  if (input.format !== FORMAT_TAG) {
    throw new DocumentParseError('不是 wmind 文档（format 字段不匹配）');
  }

  const version = asString(input.formatVersion, FORMAT_VERSION);
  const major = Number.parseInt(version.split('.')[0] ?? '', 10);
  const supportedMajor = Number.parseInt(FORMAT_VERSION.split('.')[0] ?? '1', 10);
  if (Number.isFinite(major) && major > supportedMajor) {
    throw new DocumentParseError(`文档格式版本 ${version} 高于本版本支持的 ${FORMAT_VERSION}`);
  }

  const warnings: string[] = [];
  const seen = new Set<string>();
  const sheets = asArray(input.sheets).map((sheet, i) => parseSheet(sheet, i, warnings, seen));

  if (sheets.length === 0) {
    // 没有画布的文档没有意义，但也不该让用户看到空白崩溃页：
    // 补一张空画布，同时留下警告让上层提示「文件可能已损坏」。
    warnings.push('文档没有任何画布，已补一张空画布');
    sheets.push(parseSheet({}, 0, warnings, seen));
  }

  const meta = isRecord(input.meta) ? input.meta : {};
  const now = new Date().toISOString();

  return {
    document: {
      format: FORMAT_TAG,
      formatVersion: FORMAT_VERSION,
      id: asString(input.id) || newDocumentId(),
      title: asString(input.title, '未命名导图'),
      theme: parseTheme(input.theme, warnings),
      sheets,
      meta: {
        createdAt: asString(meta.createdAt, now),
        updatedAt: asString(meta.updatedAt, now),
        app: asString(meta.app, 'wmind/1.0.0'),
      },
      extensions: asArray(input.extensions),
    },
    warnings,
  };
}
