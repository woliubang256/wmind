/** 独立 UI 回归：本地演示文档 + 模拟认证，不依赖后端或修改用户数据。 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { BASE, launchBrowser } from './lib/harness.mjs';

const browser = await launchBrowser();
try {
  const page = await browser.contexts()[0].newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/v1/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    const user = { uid: 'navigation-test', username: '导航测试', email: 'navigation@example.test', role: 'user', status: 'active', settings: {} };
    const data = path.endsWith('/auth/refresh') ? { accessToken: 'fixture-token', expiresIn: 900, user }
      : path.endsWith('/auth/me') ? user : { siteName: 'wmind', brand: 'wmind', exportEnabled: true, importEnabled: true };
    return route.fulfill({ json: { data } });
  });
  await page.goto(`${BASE}/maps/demo`);
  await page.locator('g.wmind-topic').first().waitFor();
  const footer = page.locator('footer');
  const add = page.getByRole('button', { name: '新建画布', exact: true });
  assert.equal(await footer.getByRole('tablist').count(), 1);
  const tab = footer.getByRole('tab').first();
  const firstName = await tab.textContent();
  const openMenu = async () => {
    await footer.getByRole('tab', { selected: true }).click({ button: 'right' });
    await page.getByRole('menu').waitFor();
  };
  await openMenu();
  assert.equal(await page.getByRole('menuitem', { name: '粘贴', exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('menuitem', { name: '删除画布', exact: true }).isDisabled(), true);
  const menuSize = await page.getByRole('menu').evaluate((e) => ({ height: e.clientHeight, scroll: e.scrollHeight, bottom: e.getBoundingClientRect().bottom }));
  assert.equal(menuSize.height, menuSize.scroll);
  assert.ok(menuSize.bottom < 900);
  await page.getByRole('menuitem', { name: '拷贝', exact: true }).click();
  await add.click();
  assert.equal(await footer.getByRole('tab').count(), 2);
  await openMenu();
  await page.getByRole('menuitem', { name: '粘贴', exact: true }).click();
  assert.equal(await footer.getByRole('tab').count(), 3);
  await openMenu();
  await page.getByRole('menuitem', { name: '复制', exact: true }).click();
  assert.equal(await footer.getByRole('tab').count(), 4);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  assert.equal(await footer.getByRole('tab').count(), 3);
  await page.getByRole('button', { name: '重做', exact: true }).click();
  assert.equal(await footer.getByRole('tab').count(), 4);
  await openMenu();
  const downloaded = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: '画布另存为…', exact: true }).click();
  const download = await downloaded;
  const saved = JSON.parse(await readFile(await download.path(), 'utf8'));
  assert.equal(saved.format, 'wmind');
  assert.equal(saved.sheets.length, 1);
  assert.equal(saved.sheets[0].rootTopic.title, '产品规划');
  await openMenu();
  await page.getByRole('menuitem', { name: '重命名画布', exact: true }).click();
  await page.getByRole('textbox', { name: '重命名画布' }).fill('导航回归');
  await page.keyboard.press('Enter');
  assert.equal(await footer.getByRole('tab', { selected: true }).textContent(), '导航回归');
  await openMenu();
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('menu').count(), 0);
  await openMenu();
  await page.getByRole('menuitem', { name: '删除画布', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '删除画布', exact: true }).click();
  assert.equal(await footer.getByRole('tab').count(), 3);
  await footer.getByRole('tab', { name: firstName, exact: true }).click();
  const root = page.locator('g.wmind-topic').filter({ hasText: /^产品规划$/ });
  const zoom = page.getByRole('combobox', { name: '快捷缩放' });
  await zoom.click();
  await page.getByRole('option', { name: '150%', exact: true }).click();
  const zoomBefore = await zoom.textContent();
  for (const direction of ['horizontal', 'vertical']) {
    const bar = page.locator(`[data-canvas-scrollbar="${direction}"]`);
    const thumb = bar.locator('[data-scroll-thumb]');
    const box = await thumb.boundingBox();
    const before = await root.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + (direction === 'horizontal' ? 60 : 0), box.y + box.height / 2 + (direction === 'vertical' ? 60 : 0), { steps: 5 });
    await page.mouse.up();
    const after = await root.boundingBox();
    assert.ok(direction === 'horizontal' ? after.x < before.x : after.y < before.y);
    await bar.focus();
    await page.keyboard.press(direction === 'horizontal' ? 'ArrowRight' : 'ArrowDown');
  }
  await page.getByRole('button', { name: '定位中心主题' }).click();
  const canvas = await page.locator('#editor-canvas-surface').boundingBox();
  const centered = await root.locator(':scope > rect').first().boundingBox();
  assert.ok(Math.abs(centered.x + centered.width / 2 - canvas.x - canvas.width / 2) < 1);
  assert.ok(Math.abs(centered.y + centered.height / 2 - canvas.y - canvas.height / 2) < 1);
  assert.equal(await zoom.textContent(), zoomBefore);
  await page.screenshot({ path: '/tmp/wmind-canvas-navigation.png' });
  for (const width of [375, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    assert.ok(await footer.evaluate((element) => element.scrollWidth <= element.clientWidth));
  }
  assert.deepEqual(errors, []);
  console.log('PASS: 单行底栏、菜单操作与另存为、双轴拖动、键盘滚动、原比例中心定位、窄屏布局');
} finally { await browser.close(); }
