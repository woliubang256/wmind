/** 面板入口回归：本地演示图 + 模拟认证，不修改后端数据。 */
import assert from 'node:assert/strict';
import { BASE, launchBrowser } from './lib/harness.mjs';

const browser = await launchBrowser();
try {
  const page = await browser.contexts()[0].newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/v1/**', (route) => route.fulfill({ json: { data: route.request().url().endsWith('/auth/me')
    ? { id: 'panel-test', username: '面板测试', email: 'panel@example.test', role: 'user', settings: {} }
    : { siteName: 'wmind', brand: 'wmind', exportEnabled: true, importEnabled: true } } }));
  await page.goto(`${BASE}/maps/demo`);
  await page.locator('g.wmind-topic').first().waitFor();
  const toolbar = page.locator('[data-editor-toolbar]');
  assert.equal(await toolbar.getByRole('button', { name: /隐藏面板|显示面板/ }).count(), 0);
  assert.equal(await toolbar.getByRole('combobox', { name: '结构', exact: true }).count(), 0);
  assert.equal(await page.getByRole('tab', { name: '演说', exact: true }).count(), 0);
  const panel = page.locator('#editor-canvas-panel');
  const labels = await panel.getByRole('tab').allTextContents();
  assert.deepEqual(labels, ['样式', '配色', '标记', '结构']);
  await panel.getByRole('tab', { name: '样式', exact: true }).focus();
  await page.keyboard.press('ArrowLeft');
  assert.equal(await panel.getByRole('tab', { name: '结构', exact: true }).getAttribute('aria-selected'), 'true');
  await page.keyboard.press('ArrowRight');
  const structure = panel.getByRole('combobox', { name: '结构', exact: true });
  const initial = await structure.getAttribute('data-value');
  await structure.click();
  await page.getByRole('option', { name: '逻辑图（向右）', exact: true }).click();
  assert.notEqual(await structure.getAttribute('data-value'), initial);
  await toolbar.getByRole('button', { name: '撤销', exact: true }).click();
  assert.equal(await structure.getAttribute('data-value'), initial);
  for (const width of [1440, 375]) {
    await page.setViewportSize({ width, height: 1000 });
    const hide = page.getByRole('button', { name: '隐藏面板', exact: true });
    await hide.hover();
    assert.equal(await page.getByRole('tooltip').textContent(), '隐藏面板');
    const before = await hide.boundingBox();
    await hide.click();
    const show = page.getByRole('button', { name: '显示面板', exact: true });
    await show.waitFor();
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '显示面板');
    assert.equal(await panel.count(), 0);
    const after = await show.boundingBox();
    assert.ok(Math.abs(before.x - after.x) < 1 && Math.abs(before.y - after.y) < 1);
    assert.ok(after.x >= 0 && after.x + after.width <= width);
    assert.ok(await show.evaluate((e) => parseFloat(getComputedStyle(e).borderRadius) >= e.clientHeight / 2));
    await show.hover();
    assert.equal(await page.getByRole('tooltip').textContent(), '显示面板');
    await page.screenshot({ path: `/tmp/wmind-panel-collapsed-${width}.png` });
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '隐藏面板');
    assert.equal(await panel.count(), 1);
  }
  await page.getByRole('button', { name: '只读预览', exact: true }).click();
  assert.equal(await panel.count(), 0);
  assert.equal(await page.getByRole('button', { name: /隐藏面板|显示面板/ }).count(), 0);
  await page.getByRole('button', { name: '退出预览', exact: true }).click();
  await page.getByRole('button', { name: '大纲视图', exact: true }).first().click();
  assert.equal(await page.getByRole('button', { name: /隐藏面板|显示面板/ }).count(), 0);
  await page.getByRole('button', { name: '大纲视图', exact: true }).first().click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: '进入 ZEN 模式', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: /隐藏面板|显示面板/ }).count(), 0);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '隐藏面板', exact: true }).waitFor();
  await page.screenshot({ path: '/tmp/wmind-panel-expanded.png' });
  assert.deepEqual(errors, []);
  console.log('PASS: 面板唯一入口、同位置圆形展开、悬停与焦点、四页签键盘、结构撤销、预览/大纲/ZEN、375/1440px');
} finally { await browser.close(); }
