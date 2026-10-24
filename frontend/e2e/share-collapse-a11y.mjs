/** 匿名分享折叠可访问性：所有 API 全拦截，不写真实数据。 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { BASE, check, launchBrowser, summary } from './lib/harness.mjs';

const topic = (id, title, attached = [], collapsed = false) => ({ id, title, collapsed, children: { attached, detached: [] } });
const document = {
  format: 'wmind', formatVersion: '1.0', id: 'collapse-a11y', title: '分享键盘折叠',
  sheets: [{ id: 'sheet', title: '画布 1', structure: 'mindmap', rootTopic: topic('root', '中心主题', [
    topic('collapsed', '折叠分支', [topic('hidden', '隐藏子主题')], true),
    topic('expanded', '展开分支', [topic('visible', '可见子主题')]),
  ]) }],
};
let writes = 0;
let authenticated = false;
const browser = await launchBrowser();
try {
  const page = await browser.contexts()[0].newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace('/api/v1', '');
    if (!['GET', 'HEAD'].includes(request.method()) && path !== '/auth/refresh') writes += 1;
    let data;
    if (path === '/site/config') data = { siteName: 'wmind', exportEnabled: true, shareEnabled: true };
    else if (path === '/public/shares/collapse-a11y') data = { title: document.title, document, allowDownload: true, showNotes: false, ownerNickname: '作者', createdAt: '2026-10-25T00:00:00Z' };
    else if (path === '/auth/refresh') {
      if (authenticated) {
        await route.fulfill({ json: { data: { accessToken: 'fixture-token', expiresIn: 900, user: { uid: 'fixture', username: 'fixture', email: 'fixture@example.test', role: 'user', status: 'active', settings: {} } } } });
        return;
      }
      await route.fulfill({ status: 401, json: { error: { code: 'AUTH_TOKEN_INVALID' } } });
      return;
    } else if (path === '/maps/collapse-a11y') data = { uid: 'collapse-a11y', title: document.title, document, version: 1, updatedAt: '2026-10-25T00:00:00Z', thumbnailUrl: '/fixture.png' };
    else data = [];
    await route.fulfill({ json: { data } });
  });
  await page.goto(`${BASE}/s/collapse-a11y`);
  await page.locator('[data-topic-id="root"]').waitFor();
  check('交互只读SVG作为有名称的group暴露子按钮', await page.getByRole('group', { name: '分享键盘折叠', exact: true }).count() === 1);
  const collapsed = page.locator('[data-collapse-toggle="collapsed"]');
  const expanded = page.locator('[data-collapse-toggle="expanded"]');
  check('折叠徽标以有名称的按钮进入读屏树', await page.getByRole('button', { name: '折叠 / 展开: 折叠分支', exact: true }).count() === 1);
  check('有后代的展开节点也暴露折叠按钮', await page.getByRole('button', { name: '折叠 / 展开: 展开分支', exact: true }).count() === 1);
  check('叶子节点不产生折叠按钮', await page.locator('[data-topic-id="visible"] [data-collapse-toggle]').count() === 0);
  check('徽标报告当前折叠状态', await collapsed.getAttribute('aria-expanded') === 'false');
  check('徽标可Tab聚焦且不再aria-hidden', await collapsed.getAttribute('tabindex') === '0' && await collapsed.getAttribute('aria-hidden') !== 'true');
  await page.locator('svg[data-read-only="true"]').evaluate((svg) => {
    const before = document.createElement('button'); before.id = 'before-canvas'; svg.before(before); before.focus();
  });
  await page.keyboard.press('Tab');
  await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('[data-collapse-toggle="root"]')).opacity) > 0.95);
  check('Tab可进入原本悬停才可见的折叠按钮', await page.locator('[data-collapse-toggle="root"]').evaluate((element) => document.activeElement === element));
  await page.keyboard.press('Tab');
  check('再次Tab按节点顺序到达折叠分支按钮', await collapsed.evaluate((element) => document.activeElement === element));
  await page.locator('#before-canvas').evaluate((element) => element.remove());
  await collapsed.focus();
  check('浏览器焦点确实到达SVG折叠徽标', await collapsed.evaluate((element) => document.activeElement === element));
  await page.keyboard.press('Enter');
  check('Enter展开隐藏后代', await page.locator('[data-topic-id="hidden"]').count() === 1);
  check('展开后aria-expanded与焦点保持同步', await collapsed.getAttribute('aria-expanded') === 'true' && await collapsed.evaluate((element) => document.activeElement === element));
  await page.keyboard.down('Space');
  check('Space按钮激活不会同时启动平移抓手', await page.locator('svg[data-read-only="true"]').evaluate((element) => element.style.cursor !== 'grab'));
  await page.keyboard.up('Space');
  check('Space折叠且不滚动页面', await page.locator('[data-topic-id="hidden"]').count() === 0 && await page.evaluate(() => scrollY === 0));
  check('折叠后仍保持原按钮焦点', await collapsed.evaluate((element) => document.activeElement === element));
  await expanded.focus();
  await page.keyboard.press('Space');
  check('展开态悬停按钮也支持Space折叠', await page.locator('[data-topic-id="visible"]').count() === 0);
  await page.keyboard.press('Enter');
  check('同一按钮Enter重新展开', await page.locator('[data-topic-id="visible"]').count() === 1);
  await page.keyboard.down('Enter');
  await page.keyboard.down('Enter');
  await page.keyboard.up('Enter');
  check('长按Enter不重复折叠与展开', await page.locator('[data-topic-id="visible"]').count() === 0);
  await page.keyboard.press('Enter');
  await page.evaluate(async () => { const { default: i18n } = await import('/src/lib/i18n/index.ts'); await i18n.changeLanguage('en-US'); });
  check('折叠按钮名称随语言切换', await page.getByRole('button', { name: 'Collapse / expand: 展开分支', exact: true }).count() === 1);
  await page.evaluate(async () => { const { default: i18n } = await import('/src/lib/i18n/index.ts'); await i18n.changeLanguage('zh-CN'); });
  const exported = await page.evaluate(async (fixture) => {
    const { parseDocument } = await import('/src/editor/model/validate.ts');
    const { buildExportContext, DEFAULT_EXPORT_OPTIONS } = await import('/src/editor/export/context.ts');
    const { buildExportSvg } = await import('/src/editor/export/svg.ts');
    const doc = parseDocument(fixture).document;
    const svg = new DOMParser().parseFromString(buildExportSvg(buildExportContext(doc, doc.sheets[0].id, { ...DEFAULT_EXPORT_OPTIONS, format: 'svg' })), 'image/svg+xml');
    return { toggles: svg.querySelectorAll('[data-collapse-toggle]').length, buttons: svg.querySelectorAll('[role="button"], [tabindex]').length, topics: svg.querySelectorAll('[data-topic-id]').length };
  }, document);
  check('静态SVG导出不带折叠徽标、按钮或Tab停靠点', exported.toggles === 0 && exported.buttons === 0 && exported.topics === 4);
  check('折叠键盘操作不挂编辑输入框且不保存', writes === 0 && await page.locator('textarea, [contenteditable="true"]').count() === 0);
  await page.reload();
  await page.locator('[data-topic-id="root"]').waitFor();
  check('刷新后恢复作者折叠而非访客临时状态', await page.locator('[data-topic-id="hidden"]').count() === 0 && await page.locator('[data-topic-id="visible"]').count() === 1);
  if (process.env.SCREENSHOT_DIR) {
    for (const width of [375, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.screenshot({ path: join(process.env.SCREENSHOT_DIR, `wmind-share-state-${width}.png`) });
    }
  }
  authenticated = true;
  await page.goto(`${BASE}/maps/collapse-a11y`);
  await page.locator('[data-topic-id="root"]').waitFor();
  check('编辑画布继续暴露treeitem而不是只读group', await page.getByRole('treeitem', { name: '中心主题', exact: true }).count() === 1 && await page.locator('svg[data-read-only="false"]').getAttribute('role') === 'none');
  const authorBadge = page.locator('[data-collapse-toggle="collapsed"]');
  check('编辑画布保留原树焦点策略，不新增徽标Tab停靠点', await authorBadge.getAttribute('tabindex') === null && await authorBadge.getAttribute('aria-hidden') === 'true');
  await authorBadge.click();
  check('编辑端原有鼠标折叠仍有效', await page.getByRole('treeitem', { name: '隐藏子主题', exact: true }).count() === 1);
  await page.evaluate(async (fixture) => {
    const { default: React } = await import('/node_modules/.vite/deps/react.js');
    const { default: { createRoot } } = await import('/node_modules/.vite/deps/react-dom_client.js');
    const { MindMapViewer } = await import('/src/editor/viewer/mind-map-viewer.tsx');
    const { parseDocument } = await import('/src/editor/model/validate.ts');
    const doc = parseDocument(fixture).document;
    const container = document.createElement('div'); container.id = 'static-viewer-fixture'; container.style.height = '400px'; document.body.append(container);
    createRoot(container).render(React.createElement(MindMapViewer, { sheet: doc.sheets[0], theme: doc.theme, readOnly: true, ariaLabel: '静态查看器' }));
  }, document);
  await page.locator('#static-viewer-fixture svg').waitFor();
  check('无交互插件的只读查看器保留img且不暴露空按钮', await page.locator('#static-viewer-fixture').getByRole('img', { name: '静态查看器', exact: true }).count() === 1 && await page.locator('#static-viewer-fixture').getByRole('button').count() === 0);
  assert.deepEqual(errors, []);
  if (!summary()) process.exitCode = 1;
} finally { await browser.close(); }
