/** 所有 API 均由本地夹具响应，不写开发或线上导图。 */
import assert from 'node:assert/strict';
import { BASE, check, launchBrowser, summary } from './lib/harness.mjs';

const topic = (id, title, attached = [], collapsed = false) => ({ id, title, collapsed, children: { attached, detached: [] } });
let document = {
  format: 'wmind', formatVersion: '1.0', id: 'state-doc', title: '分享视图回归',
  sheets: [
    { id: 'first', title: '画布甲', structure: 'mindmap', rootTopic: topic('root', '中心主题', [topic('a', '折叠分支', [topic('a1', '隐藏子主题')], true), topic('b', '展开分支', [topic('b1', '可见子主题')])]) },
    { id: 'second', title: '画布乙', structure: 'org-chart', rootTopic: topic('root2', '第二中心', [topic('c', '第二子主题')]) },
  ],
  viewState: { activeSheetId: 'first', sheets: { first: { centerX: 400, centerY: 80, zoom: 1.25 }, second: { centerX: 50, centerY: 70, zoom: 0.75 } } },
};
let version = 1;
let writes = 0;
const browser = await launchBrowser();
try {
  const page = await browser.contexts()[0].newPage();
  const errors = [];
  page.on('pageerror', (error) => { errors.push(error.message); console.error(error.message); });
  page.on('dialog', (dialog) => dialog.accept());
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace('/api/v1', '');
    const user = { uid: 'state-user', username: 'fixture', nickname: '', email: 'fixture@example.test', role: 'user', status: 'active', settings: {} };
    let data;
    if (path === '/auth/refresh') data = { accessToken: 'fixture', expiresIn: 900, user };
    else if (path === '/auth/me') data = user;
    else if (path === '/site/config') data = { siteName: 'wmind', brand: '画布品牌', exportEnabled: true, shareEnabled: true };
    else if (path === '/public/shares/state') data = { title: document.title, document, allowDownload: true, showNotes: false, ownerNickname: '作者', createdAt: '2026-10-25T00:00:00Z' };
    else if (path === '/maps/state') {
      if (request.method() === 'PUT') { document = request.postDataJSON().document; version += 1; writes += 1; }
      data = { uid: 'state', title: document.title, document, version, updatedAt: '2026-10-25T00:00:00Z', thumbnailUrl: '/fixture.png' };
    } else if (path.endsWith('/thumbnail')) data = {};
    else data = [];
    await route.fulfill({ json: { data } });
  });
  await page.goto(`${BASE}/s/state`);
  await page.locator('g.wmind-topic').first().waitFor();
  const transform = () => page.locator('g.viewport').getAttribute('transform');
  check('分享画布有横竖滚动条', await page.getByRole('scrollbar').count() === 2);
  check('分享有显式缩放入口', await page.getByRole('button', { name: '放大', exact: true }).count() === 1);
  check('打开使用作者缩放', (await transform()).includes('scale(1.25)'));
  await page.locator('[data-collapse-toggle="a"]').click();
  check('分享折叠节点可以展开', await page.locator('[data-topic-id="a1"]').count() === 1);
  if (await page.getByRole('scrollbar').count() === 2) {
    for (const direction of ['horizontal', 'vertical']) {
      const bar = page.getByRole('scrollbar', { name: direction === 'horizontal' ? '横向滚动画布' : '纵向滚动画布' });
      const thumb = bar.locator('[data-scroll-thumb]');
      const rect = await thumb.boundingBox();
      const before = await transform();
      await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
      await page.mouse.down();
      await page.mouse.move(rect.x + rect.width / 2 + (direction === 'horizontal' ? 35 : 0), rect.y + rect.height / 2 + (direction === 'vertical' ? 35 : 0), { steps: 4 });
      await page.mouse.up();
      check(`${direction}滑块能拖动画布`, before !== await transform());
      await bar.focus();
      await page.keyboard.press(direction === 'horizontal' ? 'ArrowRight' : 'ArrowDown');
    }
    await page.getByRole('button', { name: '放大', exact: true }).click();
    const zoomed = await transform();
    check('分享缩放按钮生效', zoomed.includes('scale(1.5)'));
    await page.getByRole('button', { name: '定位中心主题', exact: true }).click();
    check('分享定位保持当前缩放', (await transform()).includes('scale(1.5)'));
    await page.getByRole('combobox', { name: '画布列表', exact: true }).click();
    await page.getByRole('option', { name: '画布乙', exact: true }).click();
    check('分享切画布保留作者各自视图', (await transform()).includes('scale(0.75)') && await page.locator('[data-topic-id="root2"]').count() === 1);
  }
  check('访客交互不保存文档', writes === 0);
  await page.reload();
  await page.locator('[data-topic-id="root"]').waitFor();
  check('刷新恢复作者折叠状态', await page.locator('[data-topic-id="a1"]').count() === 0);
  check('刷新恢复作者缩放', (await transform()).includes('scale(1.25)'));
  check('分享不存在编辑输入框', await page.locator('textarea, [contenteditable="true"]').count() === 0);
  // editor 与 share 使用同一夹具，验证自动保存确实把新视图交给分享。
  await page.goto(`${BASE}/maps/state`);
  await page.locator('[data-topic-id="root"]').waitFor();
  check('编辑重开读取保存倍率', (await transform()).includes('scale(1.25)'));
  await page.locator('[data-collapse-toggle="a"]').click();
  await page.getByRole('combobox', { name: '快捷缩放', exact: true }).click();
  await page.getByRole('option', { name: '150%', exact: true }).click();
  await page.getByRole('button', { name: '定位中心主题', exact: true }).click();
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => document.body.innerText.includes('已保存'));
  check('作者视角通过自动保存落盘', writes > 0 && document.viewState.sheets.first.zoom === 1.5);
  const saved = structuredClone(document.viewState.sheets.first);
  check('作者折叠状态通过自动保存落盘', document.sheets[0].rootTopic.children.attached[0].collapsed === false);
  await page.reload();
  await page.locator('[data-topic-id="a1"]').waitFor();
  check('编辑刷新恢复折叠和视角', (await transform()).includes('scale(1.5)'));
  await page.getByRole('tab', { name: '画布乙', exact: true }).click();
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => document.body.innerText.includes('已保存'));
  check('保存当前画布', document.viewState.activeSheetId === 'second');
  await page.goto(`${BASE}/s/state`);
  await page.locator('[data-topic-id="root2"]').waitFor();
  check('分享初始打开作者最后画布', (await transform()).includes('scale(0.75)'));
  for (const width of [375, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    check(`${width}分享页面不横向溢出`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  }
  assert.equal(saved.zoom, 1.5);
  assert.deepEqual(errors, []);
  if (!summary()) process.exitCode = 1;
} finally { await browser.close(); }
