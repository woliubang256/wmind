/** 分享首屏必须等字体：真实延迟字体样式表，并直接监测 Canvas 测字，而非只看节点是否隐藏。 */
import assert from 'node:assert/strict';
import { BASE, check, launchBrowser, newPage, run, summary } from './lib/harness.mjs';

const document = {
  format: 'wmind', formatVersion: '1.0', id: 'font-gate-doc', title: '分享字体加载夹具',
  sheets: [{ id: 'font-sheet', title: '画布', rootTopic: {
    id: 'font-root', title: 'FONT_GATE_ROOT', children: { attached: [
      { id: 'font-child', title: 'FONT_GATE_CHILD', children: { attached: [] } },
    ] },
  } }],
  viewState: { activeSheetId: 'font-sheet', sheets: { 'font-sheet': { centerX: 150, centerY: 200, zoom: 1.25 } } },
};

run(async () => {
  const browser = await launchBrowser();
  let releaseFonts;
  const gate = new Promise((resolve) => { releaseFonts = resolve; });
  try {
    const { page, errors } = await newPage(browser);
    await page.addInitScript(() => {
      window.__shareFontGate = { released: false, measurements: [] };
      const measure = CanvasRenderingContext2D.prototype.measureText;
      CanvasRenderingContext2D.prototype.measureText = function (text) {
        if (String(text).includes('FONT_GATE')) window.__shareFontGate.measurements.push({ text, font: this.font, released: window.__shareFontGate.released });
        return measure.call(this, text);
      };
    });
    let fontRequests = 0;
    await page.route('**/fonts/sans.css', async (route) => {
      fontRequests++;
      await gate;
      await route.continue();
    });
    await page.route('**/api/v1/**', async (route) => {
      const path = new URL(route.request().url()).pathname.replace('/api/v1', '');
      const user = { uid: 'font-gate-user', username: 'fixture', role: 'user', status: 'active', settings: {} };
      let data = {};
      if (path === '/auth/refresh') data = { accessToken: 'fixture-token', expiresIn: 900, user };
      if (path === '/auth/me') data = user;
      if (path === '/site/config') data = { siteName: 'wmind', brand: 'wmind', exportEnabled: false, shareEnabled: true };
      if (path === '/public/shares/font-gate') data = { title: document.title, document, allowDownload: false, showNotes: false, siteName: 'wmind', ownerNickname: '作者', createdAt: '2026-10-25T00:00:00Z', expiresAt: null };
      await route.fulfill({ json: { data } });
    });
    await page.goto(`${BASE}/s/font-gate`);
    await page.getByRole('heading', { name: document.title, exact: true }).waitFor();
    await page.waitForFunction(() => !!window.document.querySelector('link[data-wmind-font]'));
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const before = await page.evaluate(() => window.__shareFontGate.measurements);
    check('夹具真实阻塞了字体样式表', fontRequests > 0);
    check('字体未就绪不测量主题文字', before.length === 0, `提前测字${before.length}次`);
    check('等待字体时显示加载且不生成主题', await page.getByRole('status').filter({ hasText: '正在加载' }).count() > 0 && await page.locator('[data-topic-id]').count() === 0);
    check('等待字体时缩放按钮禁用', await page.getByRole('button', { name: '放大', exact: true }).isDisabled());
    await page.evaluate(() => { window.__shareFontGate.released = true; });
    releaseFonts();
    await page.locator('[data-topic-id="font-root"]').waitFor();
    const after = await page.evaluate(() => window.__shareFontGate.measurements);
    check('字体到达后才首次测量并渲染主题', after.some((item) => item.released) && await page.locator('[data-topic-id="font-child"]').count() === 1);
    check('就绪后恢复作者缩放', (await page.locator('g.viewport').getAttribute('transform')).includes('scale(1.25)'));
    check('就绪后启用交互并保留双向滚动条', await page.getByRole('button', { name: '放大', exact: true }).isEnabled() && await page.getByRole('scrollbar').count() === 2);
    await page.getByRole('button', { name: '放大', exact: true }).click();
    check('就绪后缩放正常且无页面错误', (await page.locator('g.viewport').getAttribute('transform')).includes('scale(1.5)') && errors.length === 0, errors.join('\n'));
    assert.ok(summary());
  } finally {
    releaseFonts?.();
    await browser.close();
  }
});
