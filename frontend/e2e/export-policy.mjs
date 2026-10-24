/** 全 API 夹具：JPEG 默认值、分享锁定品牌、配置迟到与实际四种图形导出。 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { strFromU8, unzipSync } from 'fflate';
import { BASE, check, launchBrowser, newContext, newPage, run, summary } from './lib/harness.mjs';

const BRAND = 'SITE MARK';
const topic = (id, title, attached = []) => ({ id, title, children: { attached } });
const document = {
  format: 'wmind', formatVersion: '1.0', id: 'policy-doc', title: '导出策略夹具',
  sheets: ['one', 'two'].map((id) => ({ id, title: id, rootTopic: topic(`${id}-root`, 'Root', [topic(`${id}-a`, 'Alpha'), topic(`${id}-b`, 'Beta')]) })),
};

async function fixture(page, { delayed = false, brand = BRAND, siteName = 'SITE NAME' } = {}) {
  let release;
  const gate = delayed ? new Promise((resolve) => { release = resolve; }) : Promise.resolve();
  const config = { siteName, brand, logoUrl: '', description: '', icp: '', exportEnabled: true, importEnabled: true, shareEnabled: true };
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace('/api/v1', '');
    const user = { uid: 'export-policy-user', username: 'tester', email: '', nickname: '', role: 'user', status: 'active' };
    let data = {};
    if (path === '/auth/me') data = user;
    if (path === '/auth/refresh') data = { user, accessToken: 'fixture-token', expiresIn: 900 };
    if (path === '/site/config') { await gate; data = config; }
    if (path.startsWith('/public/shares/')) data = {
      title: document.title, document, allowDownload: true, showNotes: false, siteName,
      logoUrl: '', ownerNickname: '作者', createdAt: '2026-10-25T00:00:00Z', expiresAt: null,
    };
    await route.fulfill({ json: { data } });
  });
  return { config, release: () => release?.() };
}

async function open(page) {
  await page.getByRole('button', { name: '导出', exact: true }).click();
  const dialog = page.locator('dialog[open]');
  await dialog.waitFor();
  return dialog;
}

async function preview(dialog) {
  return dialog.locator('img').evaluate((image) => new TextDecoder().decode(Uint8Array.from(atob(image.src.split(',')[1]), (char) => char.charCodeAt(0))));
}

async function download(page, dialog) {
  const [event] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: /^下载/ }).click()]);
  return { filename: event.suggestedFilename(), bytes: await readFile(await event.path()) };
}

function pdfJpeg(bytes) {
  const source = bytes.toString('latin1');
  const imageAt = source.indexOf('/Subtype /Image');
  const streamAt = source.indexOf('stream\n', imageAt) + 'stream\n'.length;
  const length = Number(/\/Length (\d+)/.exec(source.slice(imageAt, streamAt))?.[1]);
  assert.ok(imageAt > 0 && streamAt > 0 && length > 0, 'PDF 图像流存在');
  return bytes.subarray(streamAt, streamAt + length);
}

/** 日期关闭、留白40：底部28逻辑像素内唯一可见文字就是品牌。读取成品像素，非只看预览。 */
async function footerInk(page, bytes, type) {
  return page.evaluate(async ({ base64, type }) => {
    const image = new Image();
    image.src = `data:${type};base64,${base64}`;
    await image.decode();
    const canvas = window.document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);
    const pixels = ctx.getImageData(0, image.height - 56, image.width, 56).data;
    let ink = 0;
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i] < 220 && pixels[i + 1] < 220 && pixels[i + 2] < 220 && pixels[i + 3] > 200) ink++;
    return ink;
  }, { base64: bytes.toString('base64'), type });
}

run(async () => {
  const browser = await launchBrowser();
  try {
    // 内部：品牌仍可编辑，站点配置晚到不能清空用户草稿。
    const editorContext = await newContext(browser);
    const { page: editor, errors: editorErrors } = await newPage(browser, { context: editorContext });
    const editorFixture = await fixture(editor, { delayed: true });
    await editor.goto(`${BASE}/maps/demo`);
    await editor.locator('g.wmind-topic').first().waitFor();
    let dialog = await open(editor);
    check('内部默认 JPEG', await dialog.getByRole('radio', { name: /^JPEG/ }).getAttribute('aria-checked') === 'true');
    const text = dialog.getByRole('textbox', { name: '品牌文字', exact: true });
    await text.fill('CUSTOM MARK');
    const configResponse = editor.waitForResponse('**/api/v1/site/config');
    editorFixture.release();
    await configResponse;
    await editor.waitForTimeout(80);
    check('配置晚到保留内部自定义落款', await text.inputValue() === 'CUSTOM MARK');
    await dialog.getByRole('radio', { name: /^SVG/ }).click();
    check('内部自定义落款进入预览', (await preview(dialog)).includes('>CUSTOM MARK<'));
    await dialog.getByRole('checkbox', { name: '品牌标识', exact: true }).click();
    check('内部仍可关闭品牌', !(await preview(dialog)).includes('CUSTOM MARK'));
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    dialog = await open(editor);
    check('内部再次打开复位 JPEG 和站点品牌', await dialog.getByRole('radio', { name: /^JPEG/ }).getAttribute('aria-checked') === 'true' && await text.inputValue() === BRAND);
    check('内部无页面异常', editorErrors.length === 0, editorErrors.join('\n'));
    await editorContext.close();

    // 分享：先保持站点配置未返回，再验证同一对话框响应到达后的最新品牌。
    const shareContext = await newContext(browser);
    const { page, errors } = await newPage(browser, { context: shareContext });
    const shareFixture = await fixture(page, { delayed: true });
    await page.goto(`${BASE}/s/export-policy`);
    await page.locator('[data-topic-id]').first().waitFor();
    dialog = await open(page);
    check('分享默认 JPEG', await dialog.getByRole('radio', { name: /^JPEG/ }).getAttribute('aria-checked') === 'true');
    check('分享不渲染品牌开关或文字字段', await dialog.getByRole('checkbox', { name: '品牌标识', exact: true }).count() === 0 && await dialog.getByRole('textbox', { name: '品牌文字', exact: true }).count() === 0);
    check('配置未到前不允许抢先下载错误品牌', await dialog.getByRole('button', { name: /^下载/ }).isDisabled());
    const shareConfigResponse = page.waitForResponse('**/api/v1/site/config');
    shareFixture.release();
    await shareConfigResponse;
    await page.waitForFunction(() => {
      const image = window.document.querySelector('dialog[open] img');
      return image?.src && atob(image.src.split(',')[1]).includes('SITE MARK');
    });
    check('配置晚到立即采用正式品牌', (await preview(dialog)).includes(`>${BRAND}<`));

    for (const format of ['SVG', 'PNG', 'JPEG', 'PDF']) {
      await dialog.getByRole('radio', { name: new RegExp(`^${format}`) }).click();
      check(`分享 ${format} 始终没有品牌设置且预览带正式品牌`, await dialog.getByRole('checkbox', { name: '品牌标识', exact: true }).count() === 0 && (await preview(dialog)).includes(`>${BRAND}<`));
      const result = await download(page, dialog);
      if (format === 'SVG') {
        check('SVG 成品含锁定品牌和内嵌字体', result.bytes.toString().includes(`>${BRAND}<`) && result.bytes.toString().includes('data:font/woff2'));
      } else {
        const image = format === 'PDF' ? pdfJpeg(result.bytes) : result.bytes;
        const ink = await footerInk(page, image, format === 'PNG' ? 'image/png' : 'image/jpeg');
        check(`${format} 实际成品的页脚有品牌像素`, ink > 100, `ink=${ink}`);
      }
      if (format === 'PDF') check('PDF 成品是有效带 JPEG 的 PDF', result.bytes.toString('latin1').startsWith('%PDF-1.4') && result.filename.endsWith('.pdf'));
      dialog = await open(page);
      check(`${format} 下载后再次打开仍默认 JPEG`, await dialog.getByRole('radio', { name: /^JPEG/ }).getAttribute('aria-checked') === 'true');
    }

    await dialog.getByRole('radio', { name: /^SVG/ }).click();
    await dialog.getByRole('radio', { name: /全部画布/ }).click();
    const multi = await preview(dialog);
    check('分享多画布预览仍带锁定品牌', multi.includes('data-export-sheet="one"') && multi.includes('data-export-sheet="two"') && multi.includes(`>${BRAND}<`));
    const full = await download(page, dialog);
    check('分享多画布 SVG 成品保留两张画布与品牌', full.bytes.toString().includes('data-export-sheet="one"') && full.bytes.toString().includes('data-export-sheet="two"') && full.bytes.toString().includes(`>${BRAND}<`));
    dialog = await open(page);
    for (const format of ['SVG', 'PNG', 'JPEG', 'PDF']) {
      await dialog.getByRole('radio', { name: new RegExp(`^${format}`) }).click();
      await dialog.getByRole('checkbox', { name: /按主分支拆分/ }).click();
      const split = await download(page, dialog);
      const branches = Object.values(unzipSync(split.bytes));
      let branded = branches.length === 2;
      for (const bytes of branches) {
        if (format === 'SVG') branded &&= strFromU8(bytes).includes(`>${BRAND}<`);
        else {
          const image = format === 'PDF' ? pdfJpeg(Buffer.from(bytes)) : Buffer.from(bytes);
          branded &&= await footerInk(page, image, format === 'PNG' ? 'image/png' : 'image/jpeg') > 100;
        }
      }
      check(`分享拆分的每份 ${format} 成品均带品牌`, branded);
      dialog = await open(page);
    }
    for (const format of ['Markdown', 'OPML', 'XMind']) {
      await dialog.getByRole('radio', { name: new RegExp(`^${format}`) }).click();
      check(`${format} 非图形预览不添加品牌文字或修改入口`, !(await dialog.locator('pre').textContent()).includes(BRAND) && await dialog.getByRole('textbox', { name: '品牌文字', exact: true }).count() === 0);
    }
    check('分享无页面异常', errors.length === 0, errors.join('\n'));
    await shareContext.close();

    // 空品牌由站点名称接管；不是固定写死 wmind。
    const fallbackContext = await newContext(browser);
    const { page: fallback } = await newPage(browser, { context: fallbackContext });
    await fixture(fallback, { brand: '  ', siteName: 'FALLBACK SITE' });
    await fallback.goto(`${BASE}/s/export-policy`);
    await fallback.locator('[data-topic-id]').first().waitFor();
    dialog = await open(fallback);
    check('分享空品牌回退当前站点名', (await preview(dialog)).includes('>FALLBACK SITE<'));
    await fallbackContext.close();
    assert.ok(summary());
  } finally {
    await browser.close();
  }
});
