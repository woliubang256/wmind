/**
 * Markdown 与 OPML 导出。
 *
 * 纯文本序列化：从文档模型直接生成，不碰布局、不碰渲染。这两个格式的**价值**
 * 就在于「能被别的工具读」，所以输出优先考虑「能不能被正确解析」而不是「长得
 * 像不像导图」。
 *
 * 一条硬约束：**必须能被本项目自己的导入器读回来，层级不变**（IE-16 / IE-17）。
 * 所有取舍都是围绕这一条做的，下面每处都写清了原因。
 */

import type { Sheet, Topic, WmindDocument } from '../model/types';

/** 一层缩进。两格：Markdown 里 2 空格足以区分层级，4 格会让深层内容跑得很远。 */
const INDENT = '  ';

/**
 * 把标题变成能安全放进 Markdown 行首的文本。
 *
 * 只处理「行首会被当成语法」的字符：`#` 会被读成标题，`-`/`*`/`+` 会被读成列表，
 * `>` 会被读成引用。标题中间的同名字符不用管——`产品 #1` 里的 `#` 不会被误读。
 *
 * 换行直接压成空格：模型里标题是单行的，但导入来的数据可能带 `\n`（XMind 的
 * 富文本标题），不压平会把一条节点拆成两行，读回来多一个节点。
 */
function escapeLineStart(text: string): string {
  const flat = text.replace(/\s*\n\s*/g, ' ').trim();
  if (flat === '') return '';
  return /^[#\-*+>]/.test(flat) ? `\\${flat}` : flat;
}

/** 标签用反引号包住（与 docs/06 §3.6 的示例一致）。标签里的反引号要去掉，否则会截断。 */
function labelText(label: string): string {
  return `\`${label.replace(/`/g, '')}\``;
}

/**
 * 一行节点文本 + 附属信息。
 *
 * 顺序固定：标题、链接、标签、备注摘要。链接与图片只在**没有**同名标题时才有意义，
 * 但为了不让标题凭空消失，链接写成 `[标题](href)` 而不是只留 href。
 */
function inlineOf(topic: Topic): string {
  const title = escapeLineStart(topic.title) || '(未命名)';
  const parts: string[] = [];

  if (topic.href !== null && topic.href !== '') {
    parts.push(`[${title}](${topic.href})`);
  } else if (topic.image !== null && topic.image.src !== '') {
    parts.push(`![${title}](${topic.image.src})`);
  } else {
    parts.push(title);
  }

  for (const label of topic.labels) {
    const text = labelText(label);
    if (text !== '``') parts.push(text);
  }

  return parts.join(' ');
}

/** 备注写成引用块，缩进跟着节点层级走，读回来才会挂到同一个节点下。 */
function noteLines(topic: Topic, depth: number): string[] {
  const plain = topic.notes?.plain?.trim() ?? '';
  if (plain === '') return [];
  return plain
    .split('\n')
    .map((line) => `${INDENT.repeat(depth)}> ${line}`.trimEnd());
}

/**
 * 为什么第 0、1 层用标题、第 2 层往下用列表：
 *
 * 只用列表的话，导入器的模式判定（`headingCount >= 2`）会判成 list 模式，根节点
 * 变成文件名，整棵树的根就丢了。只用标题的话，20 个一级分支就是 20 个 `##`，
 * 层级信息全挤在标题级别里，超过 6 级就没法表示（Markdown 只有 6 级标题）。
 *
 * 两级标题 + 无限层列表正好卡在两者之间：`#` 是根、`##` 是一级分支，再往下交给
 * 列表的缩进——而缩进没有 6 级上限。这个形状也正好是 docs/06 §3.6 的示例。
 */
function markdownTree(topic: Topic, depth: number, out: string[]): void {
  if (depth <= 1) {
    // 标题前空一行：紧跟在列表项后面会读成同一段。开头的第一个标题不空。
    if (out.length > 0) out.push('');
    out.push(`${'#'.repeat(depth + 1)} ${inlineOf(topic)}`);
    // 标题与备注之间也空一行：不空的话 `## 一期` 紧贴着 `> 备注`，与 docs/06
    // §3.6 的示例不一致。
    const notes = noteLines(topic, 0);
    if (notes.length > 0) {
      out.push('');
      out.push(...notes);
    }
    out.push('');
  } else {
    const indent = INDENT.repeat(depth - 2);
    out.push(`${indent}- ${inlineOf(topic)}`);
    out.push(...noteLines(topic, depth - 2));
  }

  for (const child of topic.children.attached) markdownTree(child, depth + 1, out);
}

/** 游离主题追加在末尾，用一个小标题隔开：它们本来就不在树上。 */
function markdownFloating(sheet: Sheet, out: string[]): void {
  if (sheet.floatingTopics.length === 0) return;
  out.push('## 游离主题');
  out.push('');
  for (const topic of sheet.floatingTopics) {
    out.push(`- ${inlineOf(topic)}`);
    out.push(...noteLines(topic, 0));
  }
}

/**
 * 导出 Markdown。
 *
 * `sheetId` 找不到时用第一张画布，与导出上下文的行为一致（导出的是内容，不是 id）。
 */
export function exportMarkdown(document: WmindDocument, sheetId: string | null): string {
  const sheet = document.sheets.find((item) => item.id === sheetId) ?? document.sheets[0];
  if (sheet === undefined) return `# ${escapeLineStart(document.title) || '(未命名导图)'}\n`;

  const out: string[] = [];
  markdownTree(sheet.rootTopic, 0, out);
  markdownFloating(sheet, out);

  // 收尾：去掉连续空行与末尾空行。逐个 `push('')` 的地方很难避免重复，
  // 与其在每处都判断，不如最后统一压一遍。
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

/** XML 属性值转义。`'` 也要转——属性用双引号包，但有的解析器对单引号同样敏感。 */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function opmlOutline(topic: Topic, depth: number, out: string[]): void {
  const indent = INDENT.repeat(depth + 2);
  const attributes = [`text="${escapeXml(topic.title || '(未命名)')}"`];

  const note = topic.notes?.plain?.trim() ?? '';
  if (note !== '') attributes.push(`_note="${escapeXml(note)}"`);

  // 标签用 `_labels`：与 `_note` / `_link` 同一套下划线扩展，本项目的导入器
  // （`import/opml.ts`）认它，别的工具会忽略。不写的话「导出 → 导入」标签
  // 会静默消失——而 Markdown 那边是保住的，两个格式不一致比丢字段更难解释。
  if (topic.labels.length > 0) attributes.push(`_labels="${escapeXml(topic.labels.join(','))}"`);

  // 折叠状态用 `_collapse`：OPML 没有标准字段，下划线前缀是业界惯例（OmniOutliner
  // 等都用这个写法），不认识它的工具会直接忽略。
  if (topic.collapsed) attributes.push('_collapse="true"');

  const children = topic.children.attached;
  if (children.length === 0) {
    out.push(`${indent}<outline ${attributes.join(' ')}/>`);
    return;
  }

  out.push(`${indent}<outline ${attributes.join(' ')}>`);
  for (const child of children) opmlOutline(child, depth + 1, out);
  out.push(`${indent}</outline>`);
}

/**
 * 导出 OPML 2.0。
 *
 * 游离主题挂在 body 顶层、根主题之后：OPML 允许 body 有多个 outline，而把它们
 * 塞进根主题下面就是凭空改结构了。
 */
export function exportOpml(document: WmindDocument, sheetId: string | null): string {
  const sheet = document.sheets.find((item) => item.id === sheetId) ?? document.sheets[0];
  const title = escapeXml(document.title || sheet?.title || '(未命名导图)');

  const body: string[] = [];
  if (sheet !== undefined) {
    opmlOutline(sheet.rootTopic, 0, body);
    for (const topic of sheet.floatingTopics) opmlOutline(topic, 0, body);
  }

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<opml version="2.0">',
    `  <head><title>${title}</title></head>`,
    '  <body>',
    ...body,
    '  </body>',
    '</opml>',
    '',
  ].join('\n');
}
