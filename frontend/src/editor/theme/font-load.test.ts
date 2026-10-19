/**
 * `font-load` 的行为测试。
 *
 * 这里最要紧的一条是**顺序**：先注入 `@font-face` 样式表，再问 `fonts.load`。
 * 反过来的话 `fonts.load` 会对着一个还没注册任何 face 的字体族立刻 resolve，
 * 拿到「假就绪」——于是用回退字体量了宽度，节点宽度永久错。这个 bug 在真实
 * 浏览器里表现为「字看着是对的，框就是差几个像素」，单元测试是唯一能便宜地
 * 把它钉死的地方。
 *
 * vitest 环境是 node（没有 DOM），所以自己造一个最小 `document`：只需要
 * `head.append` / `createElement('link')` / `fonts.load` 三样。
 *
 * 每个用例都 `resetModules` 后重新 import：模块里缓存了「样式表只注入一次」的
 * Promise，不重置的话前一个用例插过的 `<link>` 会让后一个用例量不到超时路径。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

interface FakeLink {
  rel: string;
  href: string;
  dataset: Record<string, string>;
  addEventListener: (type: string, listener: () => void) => void;
  fire: (type: string) => void;
}

interface FakeOptions {
  /** 样式表永远不 load：模拟弱网卡住。 */
  stylesheetStuck?: boolean;
  /** 样式表 404。 */
  stylesheetFails?: boolean;
  /** 分片永远不就绪。 */
  facesStuck?: boolean;
}

/** 每个用例一份干净的模块实例（见文件头的说明）。 */
async function freshModule() {
  vi.resetModules();
  return import('./font-load');
}

function installFakeDocument(options: FakeOptions = {}) {
  const links: FakeLink[] = [];
  const loaded: Array<{ font: string; text: string }> = [];

  const fakeDocument = {
    head: {
      append(node: FakeLink) {
        links.push(node);
        if (options.stylesheetStuck) return;
        queueMicrotask(() => node.fire(options.stylesheetFails ? 'error' : 'load'));
      },
    },
    createElement() {
      const listeners = new Map<string, Array<() => void>>();
      const node: FakeLink = {
        rel: '',
        href: '',
        dataset: {},
        addEventListener(type, listener) {
          const list = listeners.get(type) ?? [];
          list.push(listener);
          listeners.set(type, list);
        },
        fire(type) {
          for (const listener of listeners.get(type) ?? []) listener();
        },
      };
      return node;
    },
    fonts: {
      load(font: string, text: string) {
        loaded.push({ font, text });
        return options.facesStuck ? new Promise<never>(() => {}) : Promise.resolve([]);
      },
    },
  };

  vi.stubGlobal('document', fakeDocument);
  return { links, loaded };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ensureFonts', () => {
  it('跟随系统：不注入样式表，也不等任何分片', async () => {
    const { ensureFonts } = await freshModule();
    const { links, loaded } = installFakeDocument();

    const result = await ensureFonts('system', [], '思维导图');

    expect(result).toEqual({ ready: true, timedOut: false, weights: [] });
    expect(links).toHaveLength(0);
    expect(loaded).toHaveLength(0);
  });

  it('先注入该族样式表，再按字重等分片', async () => {
    const { ensureFonts } = await freshModule();
    const { links, loaded } = installFakeDocument();

    const result = await ensureFonts('sans', [400, 700], '思维导图');

    expect(result.ready).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(links).toHaveLength(1);
    expect(links[0].href).toBe('/fonts/sans.css');
    expect(links[0].rel).toBe('stylesheet');
    // 字体描述符里必须带字重与完整回退链，否则等到的不是真正要用的那一档。
    expect(loaded.map((entry) => entry.font)).toEqual([
      "400 16px 'Noto Sans SC', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', system-ui, sans-serif",
      "700 16px 'Noto Sans SC', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', system-ui, sans-serif",
    ]);
    // 第二个参数决定拉哪几个分片，必须传真实文本。
    expect(loaded[0].text).toBe('思维导图');
  });

  it('同一族只插一个 <link>（并发调用共用同一个 Promise）', async () => {
    const { ensureFonts } = await freshModule();
    const { links } = installFakeDocument();

    await Promise.all([
      ensureFonts('serif', [400], '标题'),
      ensureFonts('serif', [700], '标题'),
    ]);

    expect(links).toHaveLength(1);
    expect(links[0].href).toBe('/fonts/serif.css');
  });

  it('样式表 404 时立刻用回退字体继续，不白等满超时', async () => {
    const { ensureFonts } = await freshModule();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { links } = installFakeDocument({ stylesheetFails: true });

    const started = Date.now();
    const result = await ensureFonts('mono', [400], 'code', 2000);

    expect(result).toEqual({ ready: true, timedOut: false, weights: [400] });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(links).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('/fonts/mono.css');
  });

  it('样式表卡住时按超时收尾（骨架屏不会永远转）', async () => {
    const { ensureFonts } = await freshModule();
    installFakeDocument({ stylesheetStuck: true });

    const result = await ensureFonts('sans', [400], '思维导图', 20);

    expect(result).toEqual({ ready: false, timedOut: true, weights: [400] });
  });

  it('分片卡住时同样按超时收尾', async () => {
    const { ensureFonts } = await freshModule();
    installFakeDocument({ facesStuck: true });

    const result = await ensureFonts('sans', [400], '思维导图', 20);

    expect(result).toEqual({ ready: false, timedOut: true, weights: [400] });
  });

  it('空文档用常用字兜底，避免退化成「加载全部分片」', async () => {
    const { ensureFonts } = await freshModule();
    const { loaded } = installFakeDocument();

    await ensureFonts('sans', [400], '   ');

    expect(loaded[0].text).toContain('思维导图');
  });

  it('重复字重只等一次，非法字重被丢掉', async () => {
    const { ensureFonts } = await freshModule();
    const { loaded } = installFakeDocument();

    const result = await ensureFonts('sans', [400, 400, 0, -1], '字');

    expect(result.weights).toEqual([400]);
    expect(loaded).toHaveLength(1);
  });

  it('没有 DOM 的环境（SSR / 单测）直接放行', async () => {
    const { ensureFonts } = await freshModule();
    vi.stubGlobal('document', undefined);

    const result = await ensureFonts('sans', [400, 700], '思维导图');

    expect(result).toEqual({ ready: true, timedOut: false, weights: [400, 700] });
  });
});

describe('collectDocumentText', () => {
  it('把标题拼成一个字符串（load 一次比逐条快得多）', async () => {
    const { collectDocumentText } = await freshModule();

    expect(collectDocumentText(['中心主题', '分支一', '分支二'])).toBe('中心主题分支一分支二');
  });

  it('空集合得到空串，交给 ensureFonts 的兜底样本', async () => {
    const { collectDocumentText } = await freshModule();

    expect(collectDocumentText([])).toBe('');
  });
});
