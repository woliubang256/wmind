/**
 * 极小的 XML 解析器。
 *
 * 为什么自己写而不是引 `fast-xml-parser`：
 *
 * 1. **安全面**。导入解析器的输入是不可信文件。`fast-xml-parser@5.11.2` 有
 *    6 个传递依赖，其中 `is-unsafe` / `xml-naming` / `path-expression-matcher` /
 *    `@nodable/entities` / `fast-xml-builder` 都不是这个包历史上的依赖
 *    （v4.5.3 只有 `strnum`）。给一个「专门解析不可信输入」的库突然加五个
 *    陌生依赖，是典型的供应链风险信号。
 * 2. **本解析器根本不实现实体展开**。`<!DOCTYPE>` 连同内部子集一起跳过，
 *    自定义实体永远不会被定义，`&xxe;` 只会以字面量留下——XXE 与
 *    billion laughs 在结构上不可能发生，不依赖任何配置开关。
 * 3. 只需要「元素 + 属性 + 文本」，OPML 与 XMind 8 的 `content.xml` 都是这个
 *    子集。通用解析器的命名空间、schema、类型推断在这里全是负担。
 *
 * 明确**不支持**：命名空间语义（`a:b` 原样当名字）、混合内容顺序保留
 * （文本与子元素会分开）、DTD 校验。这三样本项目都用不到。
 */

export class XmlParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XmlParseError';
  }
}

export interface XmlElement {
  /** 标签名。带前缀的保持原样（`xmap:topic`）。 */
  name: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  /**
   * 直接文本内容（**不含**子元素的文本），已做实体解码。
   *
   * 不做「子元素文本也拼进来」：调用方要么要文本、要么要结构，混在一起
   * 会逼着每个调用方再拆一遍。
   */
  text: string;
}

export interface XmlParseOptions {
  /** 最大嵌套深度。防「两万个 `<a>`」把递归打爆栈。 */
  maxDepth?: number;
  /** 最大元素数。 */
  maxNodes?: number;
}

const DEFAULT_MAX_DEPTH = 256;
const DEFAULT_MAX_NODES = 200_000;

const NAME_START = /[A-Za-z_:]/;
const NAME_CHAR = /[-A-Za-z0-9_:.]/;

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/**
 * 解码实体。**只认** XML 预定义的五个 + 数字引用。
 *
 * 不认识的实体原样保留：既然没有 DTD，`&foo;` 本来就没有定义，展开它只能
 * 靠猜——而猜错比留着更糟（用户看到 `&foo;` 至少知道原文长这样）。
 */
export function decodeXmlEntities(value: string): string {
  if (!value.includes('&')) return value;
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body] ?? whole;
  });
}

/** 跳过 `<!DOCTYPE ...>`，含 `[ ... ]` 内部子集。 */
function skipDoctype(source: string, start: number): number {
  let i = start + 2; // 跳过 "<!"
  let bracket = 0;
  while (i < source.length) {
    const char = source[i];
    if (char === '[') bracket += 1;
    else if (char === ']') bracket -= 1;
    else if (char === '>' && bracket <= 0) return i + 1;
    i += 1;
  }
  throw new XmlParseError('DOCTYPE 未闭合');
}

function readName(source: string, start: number): { name: string; end: number } {
  if (!NAME_START.test(source[start] ?? '')) {
    throw new XmlParseError(`标签名非法（位置 ${start}）`);
  }
  let i = start + 1;
  while (i < source.length && NAME_CHAR.test(source[i] ?? '')) i += 1;
  return { name: source.slice(start, i), end: i };
}

function skipSpace(source: string, start: number): number {
  let i = start;
  while (i < source.length && /\s/.test(source[i] ?? '')) i += 1;
  return i;
}

interface OpenTag {
  name: string;
  attrs: Record<string, string>;
  selfClosing: boolean;
  end: number;
}

function readOpenTag(source: string, start: number): OpenTag {
  const { name, end } = readName(source, start);
  const attrs: Record<string, string> = {};
  let i = end;

  for (;;) {
    i = skipSpace(source, i);
    const char = source[i];
    if (char === undefined) throw new XmlParseError(`标签 <${name}> 未闭合`);
    if (char === '>') return { name, attrs, selfClosing: false, end: i + 1 };
    if (char === '/') {
      if (source[i + 1] !== '>') throw new XmlParseError(`标签 <${name}> 的 "/" 后缺少 ">"`);
      return { name, attrs, selfClosing: true, end: i + 2 };
    }

    const attr = readName(source, i);
    i = skipSpace(source, attr.end);
    if (source[i] !== '=') throw new XmlParseError(`属性 ${attr.name} 缺少 "="`);
    i = skipSpace(source, i + 1);

    const quote = source[i];
    if (quote !== '"' && quote !== "'") {
      throw new XmlParseError(`属性 ${attr.name} 的值必须加引号`);
    }
    const close = source.indexOf(quote, i + 1);
    if (close < 0) throw new XmlParseError(`属性 ${attr.name} 的值未闭合`);
    // 重复属性：XML 规范要求报错，这里取第一个（宽容），因为 OPML 里出现过
    // 手写工具生成的重复属性，为此拒绝整个文件不值得。
    if (!(attr.name in attrs)) attrs[attr.name] = decodeXmlEntities(source.slice(i + 1, close));
    i = close + 1;
  }
}

/**
 * 解析 XML，返回根元素。
 *
 * 失败抛 `XmlParseError`（结构错误），调用方负责转成 `ImportError`。
 */
export function parseXml(source: string, options: XmlParseOptions = {}): XmlElement {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;

  const input = source.replace(/^\uFEFF/, '');
  const roots: XmlElement[] = [];
  const stack: XmlElement[] = [];
  let nodes = 0;
  let i = 0;

  const pushText = (text: string) => {
    const current = stack[stack.length - 1];
    if (current !== undefined) current.text += text;
    else if (text.trim() !== '') throw new XmlParseError('根元素之外出现了文本');
  };

  while (i < input.length) {
    const lt = input.indexOf('<', i);
    if (lt < 0) {
      pushText(decodeXmlEntities(input.slice(i)));
      break;
    }
    if (lt > i) pushText(decodeXmlEntities(input.slice(i, lt)));

    if (input.startsWith('<!--', lt)) {
      const end = input.indexOf('-->', lt + 4);
      if (end < 0) throw new XmlParseError('注释未闭合');
      i = end + 3;
      continue;
    }
    if (input.startsWith('<![CDATA[', lt)) {
      const end = input.indexOf(']]>', lt + 9);
      if (end < 0) throw new XmlParseError('CDATA 未闭合');
      // CDATA 是字面文本，不做实体解码。
      pushText(input.slice(lt + 9, end));
      i = end + 3;
      continue;
    }
    if (input.startsWith('<?', lt)) {
      const end = input.indexOf('?>', lt + 2);
      if (end < 0) throw new XmlParseError('处理指令未闭合');
      i = end + 2;
      continue;
    }
    if (input.startsWith('<!', lt)) {
      // DOCTYPE 等声明：整段跳过。跳过意味着自定义实体永远没有定义，
      // `&xxe;` 只会以字面量留下——XXE 与实体膨胀在结构上不可能发生。
      i = skipDoctype(input, lt);
      continue;
    }
    if (input.startsWith('</', lt)) {
      const { name, end } = readName(input, lt + 2);
      const close = skipSpace(input, end);
      if (input[close] !== '>') throw new XmlParseError(`结束标签 </${name}> 未闭合`);
      const current = stack.pop();
      if (current === undefined) throw new XmlParseError(`多余的结束标签 </${name}>`);
      if (current.name !== name) {
        throw new XmlParseError(`结束标签 </${name}> 与 <${current.name}> 不匹配`);
      }
      i = close + 1;
      continue;
    }

    const tag = readOpenTag(input, lt + 1);
    nodes += 1;
    if (nodes > maxNodes) throw new XmlParseError(`元素数量超过上限（${maxNodes}）`);

    const element: XmlElement = { name: tag.name, attrs: tag.attrs, children: [], text: '' };
    const parent = stack[stack.length - 1];
    if (parent === undefined) {
      if (roots.length > 0) throw new XmlParseError('文档有多个根元素');
      roots.push(element);
    } else {
      parent.children.push(element);
    }
    if (!tag.selfClosing) {
      stack.push(element);
      if (stack.length > maxDepth) throw new XmlParseError(`嵌套过深（超过 ${maxDepth} 层）`);
    }
    i = tag.end;
  }

  if (stack.length > 0) {
    throw new XmlParseError(`标签 <${stack[stack.length - 1]?.name ?? ''}> 未闭合`);
  }
  const root = roots[0];
  if (root === undefined) throw new XmlParseError('没有找到根元素');
  return root;
}

/** 取第一个同名子元素。 */
export function childOf(element: XmlElement, name: string): XmlElement | undefined {
  return element.children.find((child) => child.name === name);
}

/** 取所有同名子元素。 */
export function childrenOf(element: XmlElement, name: string): XmlElement[] {
  return element.children.filter((child) => child.name === name);
}

/** 沿路径取子元素，如 `['body', 'outline']`。 */
export function pathOf(element: XmlElement, path: readonly string[]): XmlElement | undefined {
  let current: XmlElement | undefined = element;
  for (const name of path) {
    current = current === undefined ? undefined : childOf(current, name);
    if (current === undefined) return undefined;
  }
  return current;
}

/**
 * 去掉命名空间前缀：`xhtml:div` → `div`。
 *
 * XMind 的 `content.xml` 里 `<xhtml:img>` 与 `<img>` 指的是同一件事，前缀
 * 只取决于导出器当时绑定了哪个命名空间。按前缀匹配会漏掉一半文件。
 */
export function localName(name: string): string {
  const colon = name.indexOf(':');
  return colon < 0 ? name : name.slice(colon + 1);
}

/**
 * 按**本地名**找子元素，**忽略大小写**。
 *
 * XML 本身区分大小写，`childOf` 也严格比对；但存量文件里确实有老导出器写
 * `<OPML><BODY><OUTLINE>`，XMind 8 的属性名也有 `style-id` / `styleId` 两种
 * 写法。放宽的代价只是多认几个元素，收益是这类文件不会变成「空文档」。
 */
export function childNamed(element: XmlElement, name: string): XmlElement | undefined {
  const wanted = name.toLowerCase();
  return element.children.find((child) => localName(child.name).toLowerCase() === wanted);
}

export function childrenNamed(element: XmlElement, name: string): XmlElement[] {
  const wanted = name.toLowerCase();
  return element.children.filter((child) => localName(child.name).toLowerCase() === wanted);
}
