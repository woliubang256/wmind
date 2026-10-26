/** Text attachment UI regression. All API calls are page-local fixtures; no config or live AI is used. */
import assert from 'node:assert/strict';
import os from 'node:os';
import { chromium } from 'playwright-core';

const BASE = process.env.BASE ?? 'http://127.0.0.1:5199';
const CHROME = process.env.PLAYWRIGHT_CHROMIUM ?? `${os.homedir()}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const TEXT_EXTENSIONS = ['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'yaml', 'yml', 'xml', 'log', 'ini', 'conf', 'toml'];
const file = (name, text, mimeType = 'application/octet-stream') => ({ name, mimeType, buffer: Buffer.from(text) });
const labels = {
  'zh-CN': { open: 'AI生成', prompt: '生成要求', upload: '上传或拖拽文件', generate: '生成导图', cancel: '取消', empty: '文件中没有可读取的内容。', limit: '文字合计超过 10 万字符，请减少内容。' },
  'en-US': { open: 'Generate with AI', prompt: 'Generation instructions', upload: 'Upload or drop files', generate: 'Generate mind map', cancel: 'Cancel' },
};
let passed = 0;
function check(name, condition) {
  assert.ok(condition, name);
  passed += 1;
  console.log(`[PASS] ${name}`);
}

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox', '--font-render-hinting=none'] });
try {
  for (const locale of ['zh-CN', 'en-US']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale });
    const page = await context.newPage();
    const text = labels[locale];
    const errors = [];
    const generations = [], creations = [];
    let generateMode = 'failure';
    let releaseGenerate;
    let created;
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/api/v1/**', async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname.replace('/api/v1', '');
      const method = request.method();
      const user = { uid: 'ai-text-user', username: 'fixture', nickname: '', email: 'fixture@example.test', role: 'user', status: 'active', settings: {} };
      let data = [];
      if (path === '/auth/refresh') data = { accessToken: 'fixture', expiresIn: 900, user };
      else if (path === '/auth/me') data = user;
      else if (path === '/site/config') data = { siteName: 'wmind', aiEnabled: true, importEnabled: true, exportEnabled: true, shareEnabled: true };
      else if (path === '/ai/generate') {
        generations.push(request.postDataJSON());
        const mode = generateMode;
        if (mode === 'deferred') await new Promise((resolve) => { releaseGenerate = resolve; });
        if (mode === 'failure') {
          await route.fulfill({ status: 502, json: { error: { code: 'AI_PROVIDER_FAILED', message: 'fixture failure' } } }).catch(() => {});
          return;
        }
        data = { title: '文本生成夹具', children: [{ title: '需求', children: [] }, { title: '交付', children: [] }] };
      } else if (path === '/maps' && method === 'POST') {
        const input = request.postDataJSON();
        creations.push(input);
        created = { ...input, uid: 'ai-text-created', nodeCount: 3, version: 1, sizeBytes: 1024, thumbnailUrl: '', deleted: false, createdAt: '2026-10-26T00:00:00Z', updatedAt: '2026-10-26T00:00:00Z' };
        data = created;
      } else if (path === '/maps/ai-text-created') data = created;
      await route.fulfill({ json: { data, pagination: { page: 1, pageSize: 24, total: 0, totalPages: 1 } } }).catch(() => {});
    });
    const dialog = page.getByRole('dialog');
    const input = dialog.locator('input[type=file]');
    const form = dialog.locator('form');
    const prompt = dialog.getByRole('textbox', { name: text.prompt, exact: true });
    const open = async () => {
      await page.getByRole('button', { name: text.open, exact: true }).click();
      await dialog.waitFor();
    };
    const close = async () => {
      await dialog.getByRole('button', { name: text.cancel, exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
    };
    const fresh = async () => { await close(); await open(); };
    const generate = async () => {
      const response = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/ai/generate');
      await dialog.getByRole('button', { name: text.generate, exact: true }).click();
      await response;
      await dialog.getByRole('alert').waitFor();
      await page.waitForFunction(() => document.querySelector('form[aria-busy]')?.getAttribute('aria-busy') === 'false');
    };
    const drop = async (files) => {
      const dataTransfer = await page.evaluateHandle((items) => {
        const data = new DataTransfer();
        for (const item of items) data.items.add(new File([Uint8Array.from(atob(item.base64), (c) => c.charCodeAt(0))], item.name, { type: item.mimeType, lastModified: 123 }));
        return data;
      }, files.map(({ buffer, ...item }) => ({ ...item, base64: buffer.toString('base64') })));
      try {
        for (const type of ['dragenter', 'dragover', 'drop']) await form.dispatchEvent(type, { dataTransfer });
      } finally { await dataTransfer.dispose(); }
    };
    const rejectsBeforeRequest = async (attachment, expected) => {
      await fresh();
      await input.setInputFiles([attachment]);
      const count = generations.length;
      await dialog.getByRole('button', { name: text.generate, exact: true }).click();
      await dialog.getByRole('alert').waitFor();
      check(`${attachment.name} rejected before AI request`, generations.length === count && (!expected || (await dialog.getByRole('alert').innerText()).includes(expected)));
      check(`${attachment.name} remains available for removal`, await dialog.getByRole('listitem').count() === 1);
    };

    await page.goto(BASE);
    await open();
    const accept = (await input.getAttribute('accept')).split(',');
    check(`${locale}: picker advertises every text format and retains Office/PDF`, TEXT_EXTENSIONS.every((ext) => accept.includes(`.${ext}`)) && ['.docx', '.xlsx', '.pdf'].every((ext) => accept.includes(ext)));
    for (const width of [1440, 375]) {
      await page.setViewportSize({ width, height: 900 });
      const box = await dialog.boundingBox();
      check(`${locale}: ${width}px compact format hint and no horizontal overflow`, box.x >= 0 && box.x + box.width <= width && await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth) && (await dialog.innerText()).includes('TXT') && (await dialog.innerText()).includes('MD') && (await dialog.innerText()).includes('20 MB'));
      if (width === 1440) {
        const button = await dialog.getByRole('button', { name: text.upload, exact: true }).boundingBox();
        const hint = await input.locator('..').locator('span').boundingBox();
        check(`${locale}: desktop format hint stays beside the upload button`, Math.abs(button.y + button.height / 2 - hint.y - hint.height / 2) < 2);
      }
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    const chooserPromise = page.waitForEvent('filechooser');
    await dialog.getByRole('button', { name: text.upload, exact: true }).click();
    const chooser = await chooserPromise;
    const original = file('需求.TXT', '项目范围\n  研发与交付 😀\n');
    await chooser.setFiles([original]);
    check(`${locale}: picker accepts uppercase text extension with generic MIME`, await dialog.getByRole('listitem').count() === 1 && await dialog.getByText(original.name, { exact: true }).isVisible());
    await drop([file('unknown.bin', 'not an allowed extension')]);
    check(`${locale}: unsupported drop preserves selected text and gives localized format help`, await dialog.getByRole('listitem').count() === 1 && (await dialog.getByRole('alert').innerText()).includes('TXT') && (await dialog.getByRole('alert').innerText()).includes('MD'));
    if (locale === 'en-US') {
      check('English scenario has no browser errors', errors.length === 0);
      await context.close();
      continue;
    }

    const markdown = file('计划.md', '# 项目计划\r\n\r\n- 研发\r\n  - 测试\r\n```js\r\n<script>globalThis.__aiTextExecuted = true</script>\r\n```\r\n', 'text/markdown');
    await drop([markdown]);
    await drop([markdown]);
    check('text drops append in order and duplicate drops are ignored', await dialog.getByRole('listitem').count() === 2 && (await dialog.getByRole('listitem').allTextContents())[0].includes(original.name) && (await dialog.getByRole('listitem').allTextContents())[1].includes(markdown.name));
    await drop(Array.from({ length: 4 }, (_, n) => file(`extra-${n}.log`, 'log')));
    check('too many text files preserve existing attachments', await dialog.getByRole('listitem').count() === 2 && (await dialog.getByRole('alert').innerText()).includes('5'));
    const json = file('数据.json', '{"项目":"交付", "预算": 1200}\n', 'application/json');
    const xml = file('结构.xml', '<!DOCTYPE x [<!ENTITY sample "仅原文">]>\n<x>&sample;</x>\n', 'text/xml');
    const csv = file('预算.csv', '名称,金额\n研发,1200\n', 'text/csv');
    await input.setInputFiles([json, xml, csv]);
    check('picker and drag share a five-file ordered list', await dialog.getByRole('listitem').count() === 5);
    await prompt.fill('整理全部材料');
    await generate();
    const request = generations.at(-1);
    assert.deepEqual(request.sources, [original, markdown, json, xml, csv].map((f) => ({ name: f.name, text: f.buffer.toString(), images: [] })));
    check('AI receives literal ordered text, Markdown indentation, XML entities and CSV separators', request.prompt === '整理全部材料');
    check('attachment markup never executes in the page', await page.evaluate(() => globalThis.__aiTextExecuted !== true));
    check('provider failure preserves all source material', await dialog.getByRole('listitem').count() === 5 && await prompt.inputValue() === '整理全部材料' && creations.length === 0);

    await rejectsBeforeRequest(file('空白.txt', '\uFEFF \r\n\t'), text.empty);
    await rejectsBeforeRequest(file('伪装图片.txt', Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13])));
    await rejectsBeforeRequest(file('后段二进制.md', Buffer.concat([Buffer.from('a'.repeat(1024)), Buffer.from([0, 1, 2])])));
    await rejectsBeforeRequest(file('超限.txt', '字'.repeat(100_001)), text.limit);
    await fresh();
    await input.setInputFiles([file('上限.txt', '字'.repeat(100_000))]);
    await generate();
    check('exact 100,000-character attachment reaches AI without truncation', Array.from(generations.at(-1).sources[0].text).length === 100_000);
    await fresh();
    await input.setInputFiles([file('合计上限.md', '字'.repeat(100_000))]);
    await prompt.fill('加');
    const beforeCombined = generations.length;
    await dialog.getByRole('button', { name: text.generate, exact: true }).click();
    await dialog.getByRole('alert').waitFor();
    check('prompt and text attachments share the 100,000-character budget', generations.length === beforeCombined && (await dialog.getByRole('alert').innerText()).includes(text.limit));

    await fresh();
    const utf16 = { name: 'UTF16.txt', mimeType: '', buffer: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('中文 UTF-16\n', 'utf16le')]) };
    const gbk = { name: 'GBK.TXT', mimeType: '', buffer: Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4]) };
    await input.setInputFiles([utf16, gbk]);
    await generate();
    assert.deepEqual(generations.at(-1).sources.map((s) => s.text), ['中文 UTF-16\n', '中文测试']);
    check('browser decodes UTF-16 BOM and GBK Chinese text without replacement characters', generations.at(-1).sources.every((s) => !s.text.includes('\uFFFD')));

    await fresh();
    generateMode = 'deferred';
    await input.setInputFiles([file('取消.txt', '取消请求不会生成导图')]);
    const pending = page.waitForRequest((r) => new URL(r.url()).pathname === '/api/v1/ai/generate');
    await dialog.getByRole('button', { name: text.generate, exact: true }).click();
    await pending;
    await close();
    await open();
    generateMode = 'failure';
    releaseGenerate();
    await page.waitForTimeout(100);
    check('cancelled text generation cannot save or write into a reopened dialog', creations.length === 0 && await dialog.getByRole('listitem').count() === 0 && await prompt.inputValue() === '');
    generateMode = 'success';
    await input.setInputFiles([file('自动保存.md', '# 自动保存\n- 需求\n- 交付\n')]);
    await dialog.getByRole('button', { name: text.generate, exact: true }).click();
    await page.waitForURL('**/maps/ai-text-created');
    await page.locator('g.wmind-topic').first().waitFor();
    check('text generation creates and opens a native editable mind map', creations.length === 1 && creations[0].document.format === 'wmind' && creations[0].document.sheets[0].rootTopic.children.attached.length === 2);
    check('Chinese scenario has no browser errors', errors.length === 0);
    await context.close();
  }
  console.log(`\n${passed} text attachment UI checks passed`);
} finally { await browser.close(); }
