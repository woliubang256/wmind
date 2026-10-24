/**
 * Markdown 导入。
 *
 * 规则见 docs/06 §2.2 与 docs/03 §5.6。整体是「逐行扫描 → 令牌 → 建树」，
 * 不用正则去递归匹配整篇文档：Markdown 的大纲结构本质是**行**的序列，
 * 按行处理才能正确处理代码块（块内的 `#` 不是标题）与表格。
 *
 * 两处容易做错、这里专门处理的地方：
 *
 * 1. **层级跳跃不补空节点**。`#` 后面直接跟 `###` 时，新节点挂到最近的上级
 *    （`#`），而不是造一个空白的 `##`。空节点会让人以为文档缺内容。
 * 2. **列表层级按缩进分桶**。2 空格与 4 空格混用时，「缩进量排序后的序号」
 *    才是层级，而不是 `indent / 2`——后者在 4 空格缩进的文件里会凭空多出
 *    一倍层数。
 */

import { createTopic, defaultTheme } from '../model/create';
import { FORMAT_TAG, FORMAT_VERSION } from '../model/types';
import type { Sheet, Topic, WmindDocument } from '../model/types';
import { mapMarker } from './markers';
import type { ImportContext } from './types';

// ---------------------------------------------------------------------------
// 行内元素
// ---------------------------------------------------------------------------

export interface InlineResult {
  title: string;
  href: string;
  labels: string[];
  image: { alt: string; src: string } | null;
}

/**
 * 行内元素：代码片段 / 图片 / 链接，一条正则一次扫完。
 *
 * 用单条 alternation 而不是三次 `replace`：先抽代码再抽链接，代码里的
 * `` `[a](b)` `` 会被后一步当成链接；单条正则按出现顺序匹配，天然正确。
 */
const INLINE = /`([^`\n]+)`|!\[([^\]\n]*)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)|\[([^\]\n]+)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;

/**
 * 去掉强调标记。
 *
 * **只处理 `*` 与 `~~`，不处理 `_`**：`_` 在 `snake_case` 里随处可见，
 * 把 `foo_bar_baz` 变成 `foobarbaz` 比「保留了下划线」糟糕得多。
 */
function stripEmphasis(text: string): string {
  let out = text;
  for (let pass = 0; pass < 2; pass += 1) {
    out = out.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*]+)\*/g, '$1').replace(/~~([^~]+)~~/g, '$1');
  }
  return out;
}

/**
 * 还原行首的转义反斜杠。
 *
 * 导出时会给 `#`/`-` 这类开头加 `\`（`export/text.ts` 的 `escapeLineStart`），
 * 不还原的话「导出 → 再导入」标题会平白多出一个反斜杠。按 CommonMark，`\#`
 * 本来就该读成 `#`，所以这不是迁就自己导出的特殊处理。
 *
 * 只处理行首：Markdown 里也只有行首这几个字符会被误读成语法，标题中间的 `\`
 * 是用户自己写的，原样保留。
 */
function unescapeLineStart(text: string): string {
  return text.replace(/^\\([#\-*+>])/, '$1');
}

export function parseInline(text: string): InlineResult {
  const labels: string[] = [];
  let href = '';
  let image: InlineResult['image'] = null;

  const rest = text.replace(
    INLINE,
    (whole: string, code?: string, alt?: string, imageSrc?: string, linkText?: string, linkUrl?: string) => {
      if (code !== undefined) {
        labels.push(code);
        return '';
      }
      if (imageSrc !== undefined) {
        if (image === null) image = { alt: alt ?? '', src: imageSrc };
        return '';
      }
      if (linkUrl !== undefined) {
        // 只取第一个链接作为 href：一个主题只有一个超链接字段。
        if (href === '') href = linkUrl;
        return linkText ?? '';
      }
      return whole;
    },
  );

  // 先剥强调标记再还原转义：反过来的话 `\*a\*b` 会先变成 `*a*b`，被当成强调吃掉。
  return { title: unescapeLineStart(stripEmphasis(rest).trim()), href, labels, image };
}

// ---------------------------------------------------------------------------
// 令牌
// ---------------------------------------------------------------------------

type Token =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'item'; indent: number; text: string; task: 'done' | 'start' | null }
  | { kind: 'quote'; text: string }
  | { kind: 'code'; lang: string; code: string }
  | { kind: 'table'; rows: string[][] }
  | { kind: 'text'; text: string }
  | { kind: 'blank' };

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const ITEM_RE = /^([ \t]*)(?:[-*+]|\d+[.)])\s+(.*)$/;
const TASK_RE = /^\[([ xX])\]\s*(.*)$/;
const FENCE_RE = /^[ \t]*(`{3,}|~{3,})[ \t]*([\w+#.-]*)[ \t]*$/;
const TABLE_SEPARATOR_RE = /^\s*\|?[\s:|-]+\|[\s:|-]*$/;

/** 是否是闭合围栏：同种字符、长度不短于开启围栏、后面没有其他内容。 */
function isFenceClose(line: string, char: string, minLength: number): boolean {
  const trimmed = line.trim();
  if (trimmed.length < minLength) return false;
  for (const current of trimmed) if (current !== char) return false;
  return true;
}

/** 制表符按 4 空格算：Markdown 的惯例，也避免 tab/space 混排时层级乱跳。 */
function measureIndent(raw: string): number {
  let width = 0;
  for (const char of raw) {
    if (char === '\t') width += 4;
    else if (char === ' ') width += 1;
    else break;
  }
  return width;
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((cell) => cell.trim());
}

export function tokenizeMarkdown(text: string): Token[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const tokens: Token[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? '';

    const fence = FENCE_RE.exec(line);
    if (fence) {
      const marker = fence[1] ?? '```';
      const char = marker[0] === '`' ? '`' : '~';
      const lang = fence[2] ?? '';
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !isFenceClose(lines[i] ?? '', char, marker.length)) {
        body.push(lines[i] ?? '');
        i += 1;
      }
      // 跳过结束围栏（未闭合时 i 已到结尾）
      if (i < lines.length) i += 1;
      tokens.push({ kind: 'code', lang, code: body.join('\n') });
      continue;
    }

    if (line.trim() === '') {
      tokens.push({ kind: 'blank' });
      i += 1;
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      tokens.push({ kind: 'heading', level: (heading[1] ?? '#').length, text: (heading[2] ?? '').trim() });
      i += 1;
      continue;
    }

    if (line.trimStart().startsWith('|')) {
      const rows: string[][] = [];
      while (i < lines.length && (lines[i] ?? '').trimStart().startsWith('|')) {
        const row = lines[i] ?? '';
        i += 1;
        if (TABLE_SEPARATOR_RE.test(row)) continue;
        rows.push(splitTableRow(row));
      }
      tokens.push({ kind: 'table', rows });
      continue;
    }

    const quote = /^[ \t]*>[ \t]?(.*)$/.exec(line);
    if (quote) {
      tokens.push({ kind: 'quote', text: quote[1] ?? '' });
      i += 1;
      continue;
    }

    const item = ITEM_RE.exec(line);
    if (item) {
      let body = (item[2] ?? '').trim();
      let task: 'done' | 'start' | null = null;
      const taskMatch = TASK_RE.exec(body);
      if (taskMatch) {
        task = (taskMatch[1] ?? ' ').toLowerCase() === 'x' ? 'done' : 'start';
        body = (taskMatch[2] ?? '').trim();
      }
      tokens.push({ kind: 'item', indent: measureIndent(item[1] ?? ''), text: body, task });
      i += 1;
      continue;
    }

    tokens.push({ kind: 'text', text: line.trim() });
    i += 1;
  }

  return tokens;
}

// ---------------------------------------------------------------------------
// 模式判定
// ---------------------------------------------------------------------------

export type MarkdownMode = 'heading' | 'list';

function modeFromTokens(tokens: readonly Token[]): MarkdownMode {
  return tokens.some((token) => token.kind === 'heading') ? 'heading' : 'list';
}

/**
 * 真正的标题必须保留结构，列表再多也不能让标题退化成备注。
 *
 * 用分词结果判断，不另扫原文：围栏代码里的 # 和转义的 \# 不是标题。
 * 无标题时保留纯列表的首个正文行 / 文件名作为根节点的语义。
 */
export function detectMarkdownMode(text: string): MarkdownMode {
  return modeFromTokens(tokenizeMarkdown(text));
}

// ---------------------------------------------------------------------------
// 建树
// ---------------------------------------------------------------------------

const UNTITLED = '(未命名)';

interface BuildState {
  ctx: ImportContext;
  skippedImages: number;
}

function applyInline(topic: Topic, text: string, state: BuildState): void {
  const inline = parseInline(text);
  topic.title = state.ctx.title(inline.title) || UNTITLED;
  if (inline.href !== '') topic.href = inline.href;
  if (inline.labels.length > 0) topic.labels = inline.labels.map((label) => state.ctx.title(label));

  if (inline.image !== null) {
    // 绝对地址可以直接用。相对路径（`./img/a.png`）的字节在**文件之外**：
    // 用户只拖进来一个 .md，旁边那个 img 目录没跟过来，没有任何东西可以
    // 上传（`/files` 接口在，但没数据）。写进文档只会是一张破图，所以
    // 如实计入「未能还原」，而不是留个假 URL。
    if (/^https?:\/\//i.test(inline.image.src)) {
      topic.image = { src: inline.image.src, width: 120, height: 80 };
    } else {
      state.skippedImages += 1;
    }
  }
}

/** 任务列表 → 标记。`task-done` / `task-start` 在对照表里，不会是 null。 */
function pushTaskMarker(topic: Topic, task: 'done' | 'start'): void {
  const marker = mapMarker(`task-${task}`);
  if (marker !== null) topic.markers.push(marker);
}

function appendNotes(topic: Topic, text: string): void {
  const line = text.trim();
  if (line === '') return;
  topic.notes.plain = topic.notes.plain === '' ? line : `${topic.notes.plain}\n${line}`;
}

/**
 * 整行只有一个图片时提升成子主题。
 *
 * Markdown 里插图最常见的形式就是「一行一个 `![](...)`」。如果按普通段落写进
 * `notes.plain`，备注不渲染 Markdown，图片就彻底消失了——连警告都不会有。
 * 只有「行内没有别的文字、没有行内代码」时才提升，否则（`架构 ![图](a) 如下`）
 * 仍按段落处理，避免把一个句子拆成两个节点。
 */
function addImageTopic(parent: Topic, text: string, state: BuildState): boolean {
  const inline = parseInline(text);
  if (inline.image === null || inline.title !== '' || inline.labels.length > 0) return false;

  const topic = newTopic(state, text);
  // alt 是作者写的图注，比 `(未命名)` 有信息量。
  const alt = state.ctx.title(inline.image.alt.trim());
  if (alt !== '' && topic.title === UNTITLED) topic.title = alt;
  parent.children.attached.push(topic);
  return true;
}

function newTopic(state: BuildState, text: string): Topic {
  state.ctx.topic();
  const topic = createTopic({ id: state.ctx.ids.topic() });
  applyInline(topic, text, state);
  return topic;
}

function addCodeTopic(parent: Topic, token: { lang: string; code: string }, state: BuildState): Topic {
  const topic = newTopic(state, token.lang === '' ? '代码块' : `代码块 (${token.lang})`);
  topic.notes.plain = token.code;
  parent.children.attached.push(topic);
  return topic;
}

function addTableTopic(parent: Topic, rows: string[][], state: BuildState): void {
  state.ctx.warn('table-degraded');
  const topic = newTopic(state, '表格');
  for (const row of rows) {
    if (row.length === 0) continue;
    const cells = row.filter((cell) => cell !== '');
    if (cells.length === 0) continue;
    const rowTopic = newTopic(state, cells.join(' | '));
    topic.children.attached.push(rowTopic);
  }
  parent.children.attached.push(topic);
}

function buildHeadingMode(tokens: Token[], fileName: string, state: BuildState): { root: Topic; sheet: Sheet } {
  let root: Topic | null = null;
  const headingStack: Array<{ level: number; topic: Topic }> = [];
  const listStack: Array<{ indent: number; topic: Topic }> = [];
  let current: Topic | null = null;
  const preamble: string[] = [];

  for (const token of tokens) {
    switch (token.kind) {
      case 'heading': {
        if (root === null) {
          root = newTopic(state, token.text);
          current = root;
          headingStack.push({ level: token.level, topic: root });
          if (preamble.length > 0) root.notes.plain = preamble.join('\n');
          preamble.length = 0;
          break;
        }
        // 只弹出「层级 >= 自己」的，所以 # → ### 会直接挂到 # 上，不补空节点。
        while (headingStack.length > 0 && (headingStack[headingStack.length - 1]?.level ?? 0) >= token.level) {
          headingStack.pop();
        }
        const parent = headingStack[headingStack.length - 1]?.topic ?? root;
        const topic = newTopic(state, token.text);
        parent.children.attached.push(topic);
        headingStack.push({ level: token.level, topic });
        listStack.length = 0;
        current = topic;
        break;
      }
      case 'item': {
        if (root === null) {
          // 文件以列表开头、后面才出现标题：前面的列表仍需文件名根节点。
          root = newTopic(state, fileName);
          current = root;
          headingStack.push({ level: 0, topic: root });
        }
        while (listStack.length > 0 && (listStack[listStack.length - 1]?.indent ?? 0) >= token.indent) {
          listStack.pop();
        }
        // 弹空之后回落到**当前标题**，而不是 `current`。
        //
        // `current` 是「备注/代码块该挂哪」的游标，此刻它正是上一个列表项——
        // 拿它兜底会把同级的第二个列表项挂到第一个下面，整棵树凭空多一层。
        // headingStack 里始终至少有根主题（列表开头时也会补一个），所以不会空。
        const parent = listStack[listStack.length - 1]?.topic
          ?? headingStack[headingStack.length - 1]?.topic
          ?? root;
        const topic = newTopic(state, token.text);
        if (token.task !== null) pushTaskMarker(topic, token.task);
        parent.children.attached.push(topic);
        listStack.push({ indent: token.indent, topic });
        current = topic;
        break;
      }
      case 'quote': {
        if (root === null) preamble.push(token.text);
        else appendNotes(current ?? root, token.text);
        break;
      }
      case 'code': {
        if (root === null) {
          preamble.push(token.code);
          break;
        }
        current = addCodeTopic(current ?? root, token, state);
        break;
      }
      case 'table': {
        if (root === null) {
          preamble.push(token.rows.map((row) => row.join(' | ')).join('\n'));
          break;
        }
        addTableTopic(current ?? root, token.rows, state);
        break;
      }
      case 'text': {
        if (root === null) preamble.push(token.text);
        else if (!addImageTopic(current ?? root, token.text, state)) appendNotes(current ?? root, token.text);
        break;
      }
      case 'blank':
        break;
    }
  }

  const rootTopic = root ?? newTopic(state, fileName);
  if (root === null && preamble.length > 0) rootTopic.notes.plain = preamble.join('\n');

  return {
    root: rootTopic,
    sheet: {
      id: state.ctx.ids.sheet(),
      title: '画布 1',
      structure: 'mindmap',
      rootTopic,
      floatingTopics: [],
      relationships: [],
      boundaries: [],
      summaries: [],
      themeOverride: null,
      extensions: [],
    },
  };
}

function buildListMode(tokens: Token[], fileName: string, state: BuildState): { root: Topic; sheet: Sheet } {
  let root: Topic | null = null;
  const listStack: Array<{ indent: number; topic: Topic }> = [];
  let current: Topic | null = null;

  for (const token of tokens) {
    // 调用方已保证没有标题；保留防御性分支，不允许标题静默写入备注。
    if (token.kind === 'heading') throw new Error('Markdown headings require heading mode');
    if (token.kind === 'item') {
      if (root === null) {
        // 文件直接以列表开头：中心主题取文件名（docs/06 §2.2）。
        root = newTopic(state, fileName);
        current = root;
      }
      while (listStack.length > 0 && (listStack[listStack.length - 1]?.indent ?? 0) >= token.indent) {
        listStack.pop();
      }
      const parent = listStack[listStack.length - 1]?.topic ?? root;
      const topic = newTopic(state, token.text);
      if (token.task !== null) pushTaskMarker(topic, token.task);
      parent.children.attached.push(topic);
      listStack.push({ indent: token.indent, topic });
      current = topic;
      continue;
    }

    if (token.kind === 'blank') continue;

    if (root === null) {
      // 第一个非列表非空行 = 中心主题。
      if (token.kind === 'text') {
        root = newTopic(state, token.text);
        current = root;
      } else if (token.kind === 'quote') {
        root = newTopic(state, fileName);
        appendNotes(root, token.text);
        current = root;
      } else if (token.kind === 'code') {
        root = newTopic(state, fileName);
        current = addCodeTopic(root, token, state);
      } else {
        root = newTopic(state, fileName);
        current = root;
        addTableTopic(root, token.rows, state);
      }
      continue;
    }

    if (token.kind === 'quote') appendNotes(current ?? root, token.text);
    else if (token.kind === 'text') {
      if (!addImageTopic(current ?? root, token.text, state)) appendNotes(current ?? root, token.text);
    }
    else if (token.kind === 'code') current = addCodeTopic(current ?? root, token, state);
    else addTableTopic(current ?? root, token.rows, state);
  }

  const rootTopic = root ?? newTopic(state, fileName);
  return {
    root: rootTopic,
    sheet: {
      id: state.ctx.ids.sheet(),
      title: '画布 1',
      structure: 'mindmap',
      rootTopic,
      floatingTopics: [],
      relationships: [],
      boundaries: [],
      summaries: [],
      themeOverride: null,
      extensions: [],
    },
  };
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

export function markdownTitleFromFileName(fileName: string): string {
  const base = fileName.replace(/^.*[\\/]/, '').replace(/\.(?:md|markdown|txt)$/i, '').trim();
  return base === '' ? UNTITLED : base;
}

export function parseMarkdown(text: string, fileName: string, ctx: ImportContext): WmindDocument {
  const tokens = tokenizeMarkdown(text);
  const mode = modeFromTokens(tokens);
  const state: BuildState = { ctx, skippedImages: 0 };

  const built = mode === 'heading'
    ? buildHeadingMode(tokens, markdownTitleFromFileName(fileName), state)
    : buildListMode(tokens, markdownTitleFromFileName(fileName), state);

  if (state.skippedImages > 0) ctx.warn('image-skipped', { count: state.skippedImages });

  const now = new Date().toISOString();
  const rootTitle = built.root.title.trim();
  return {
    format: FORMAT_TAG,
    formatVersion: FORMAT_VERSION,
    id: ctx.ids.document(),
    // Markdown 没有文档级标题：中心主题就是用户写下的标题，比文件名更有意义。
    title: rootTitle === '' || rootTitle === UNTITLED ? markdownTitleFromFileName(fileName) : rootTitle,
    theme: defaultTheme(),
    sheets: [built.sheet],
    meta: { createdAt: now, updatedAt: now, app: 'markdown' },
    extensions: [],
  };
}
