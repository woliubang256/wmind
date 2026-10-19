/**
 * 备注 HTML 的白名单清洗。
 *
 * XMind 的备注带 `realHTML`，里面是完整的 HTML 片段。**当前没有任何地方渲染
 * `notes.html`**（视图层只读 `notes.plain`），所以存原样也不会立刻出事——但
 * 这正是危险所在：将来谁写一句 `dangerouslySetInnerHTML` 就继承了一个 XSS 面。
 * docs/06 §2.1.2 要求「主题标题中的 HTML 经白名单清洗后才写入 `notes.html`」，
 * 就在这里兑现。
 *
 * 策略是**白名单 + 丢弃**，不是黑名单过滤：
 *
 * - 标签只认一个固定集合，其余连同内容一起丢掉（`script` / `style` /
 *   `iframe` 这类）；
 * - 属性只认 `<a>` 上的 `href` / `title`，`href` 还要过协议白名单；
 * - 注释、CDATA、DOCTYPE 一律丢弃。
 *
 * 文本节点**原样透传**，不重新转义：源里的 `&amp;` 已经是转义态，再转一次会
 * 变成 `&amp;amp;`，用户看到的就是字面的 `&amp;`。裸 `<` 不是合法 HTML，
 * 遇到它按文本转义。
 */

/** 保留的标签。只收「表达结构或强调」的，不收任何能加载外部资源或执行脚本的。 */
const ALLOWED_TAGS = new Set([
  'p', 'div', 'span', 'br', 'hr',
  'strong', 'b', 'em', 'i', 'u', 's', 'strike', 'sub', 'sup', 'mark',
  'ul', 'ol', 'li', 'blockquote', 'pre', 'code',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
  'a',
]);

/** 允许保留的属性（仅这些标签）。其余属性全丢，`on*` 与 `style` 自然出局。 */
const ALLOWED_ATTRS: Record<string, string[]> = {
  a: ['href', 'title'],
};

/** 这些标签**连同内容**一起丢掉：留着标签只丢标签，脚本正文会变成可见文字。 */
const DROP_WITH_CONTENT = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'noscript', 'template', 'svg', 'math',
]);

/** `href` 允许的协议。`data:` 也能装 `text/html`，同样拒掉。 */
const SAFE_SCHEME = /^(?:https?:|mailto:|tel:|\/|#|\.\/|\.\.\/)/i;

const VOID_TAGS = new Set(['br', 'hr']);

const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

/** 实体解码只用于**校验** `href`，不用于输出——`jav&#x61;script:` 这类绕过要靠它识别。 */
function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);?/g, (_, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&(amp|lt|gt|quot|apos);/gi, (whole, name: string) => {
      const map: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
      return map[name.toLowerCase()] ?? whole;
    });
}

function isSafeHref(raw: string): boolean {
  // 先解码再判协议：`java&#x73;cript:` 解码后才是 `javascript:`。
  // 去掉所有空白与控制字符，`java\tscript:` 同样是绕过手法。
  const value = decodeEntities(raw).replace(/[\u0000-\u0020]+/g, '');
  return SAFE_SCHEME.test(value);
}

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

interface ParsedTag {
  closing: boolean;
  name: string;
  attrs: string;
  /** 原始片段长度，用于推进游标。 */
  length: number;
}

const TAG_RE = /^<(\/)?([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/;

/** 解析一个起始/结束标签。不是标签时返回 null。 */
function parseTag(source: string): ParsedTag | null {
  const match = TAG_RE.exec(source);
  if (!match) return null;
  const body = match[3] ?? '';
  return {
    closing: match[1] === '/',
    name: (match[2] ?? '').toLowerCase(),
    attrs: body,
    length: match[0].length,
  };
}

function rebuildAttrs(tag: string, source: string): string {
  const allowed = ALLOWED_ATTRS[tag];
  if (!allowed) return '';
  let out = '';
  ATTR_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ATTR_RE.exec(source)) !== null) {
    const name = (match[1] ?? '').toLowerCase();
    if (!allowed.includes(name)) continue;
    const raw = match[2] ?? match[3] ?? match[4] ?? '';
    if (name === 'href' && !isSafeHref(raw)) continue;
    // 统一用双引号并转义：值里原本的单引号不必处理，双引号必须转。
    out += ` ${name}="${raw.replace(/"/g, '&quot;')}"`;
  }
  return out;
}

/**
 * 清洗备注 HTML。返回的字符串只含白名单标签与白名单属性。
 *
 * 空输入、全是被丢弃内容时返回 `''`（调用方据此判断「没有富文本备注」）。
 */
export function sanitizeNotesHtml(input: string): string {
  if (typeof input !== 'string' || input === '') return '';

  let out = '';
  let i = 0;

  while (i < input.length) {
    const lt = input.indexOf('<', i);
    if (lt < 0) {
      out += input.slice(i);
      break;
    }
    out += input.slice(i, lt);

    const rest = input.slice(lt);

    // 注释 / CDATA / 声明：直接丢。
    const comment = /^<!--[\s\S]*?-->/.exec(rest);
    if (comment) {
      i = lt + comment[0].length;
      continue;
    }
    const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>/.exec(rest);
    if (cdata) {
      out += escapeText(cdata[1] ?? '');
      i = lt + cdata[0].length;
      continue;
    }
    const decl = /^<![^>]*>/.exec(rest);
    if (decl) {
      i = lt + decl[0].length;
      continue;
    }

    const tag = parseTag(rest);
    if (tag === null) {
      // 不是标签：当成文本，转义后输出，避免出现「半个标签」把后续内容吃掉。
      out += '&lt;';
      i = lt + 1;
      continue;
    }

    i = lt + tag.length;

    if (DROP_WITH_CONTENT.has(tag.name)) {
      if (!tag.closing) {
        // 跳到对应的结束标签之后。找不到就吃到结尾——宁可少一段，不要漏一段。
        const close = new RegExp(`</${tag.name}\\s*>`, 'i');
        const tail = input.slice(i);
        const found = close.exec(tail);
        i = found ? i + found.index + found[0].length : input.length;
      }
      continue;
    }

    if (!ALLOWED_TAGS.has(tag.name)) continue;

    if (tag.closing) {
      if (!VOID_TAGS.has(tag.name)) out += `</${tag.name}>`;
      continue;
    }
    if (VOID_TAGS.has(tag.name)) {
      out += `<${tag.name}>`;
      continue;
    }
    out += `<${tag.name}${rebuildAttrs(tag.name, tag.attrs)}>`;
  }

  return out.trim();
}
