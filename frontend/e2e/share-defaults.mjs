/** 分享表单回归：模拟认证、配置和分享 API，不创建真实链接。 */
import assert from 'node:assert/strict';
import { BASE, launchBrowser } from './lib/harness.mjs';

const browser = await launchBrowser();
try {
  const page = await browser.contexts()[0].newPage();
  const errors = [];
  const requests = [];
  const config = { siteName: 'wmind', brand: 'wmind', shareEnabled: true, exportEnabled: true, importEnabled: true, shareDefaultExpireDays: 7, shareDefaultAllowDownload: false };
  const existing = { uid: 'existing-share', token: 'existing-token', url: '/s/existing-token', mapUid: 'demo', mapTitle: '产品规划',
    hasPassword: false, allowDownload: true, showNotes: true, expiresAt: null, viewCount: 1,
    lastViewedAt: null, revokedAt: null, createdAt: '2026-10-23T00:00:00Z' };
  page.on('pageerror', (error) => errors.push(error.message));
  let releaseConfig;
  let configGate = new Promise((resolve) => { releaseConfig = resolve; });
  const mockApi = async (route) => {
    const url = route.request().url();
    let data = {};
    if (url.endsWith('/auth/me')) data = { id: 'share-test', username: '分享测试', email: 'share@example.test', role: 'user', settings: {} };
    else if (url.endsWith('/site/config')) {
      await configGate;
      data = config;
    } else if (url.endsWith('/shares') && route.request().method() === 'POST') {
      const input = route.request().postDataJSON();
      requests.push(input);
      data = { uid: `share-${requests.length}`, token: 'test-token', url: '/s/test-token', mapUid: 'demo', mapTitle: '产品规划',
        hasPassword: !!input.password, allowDownload: input.allowDownload, showNotes: input.showNotes,
        expiresAt: '2030-01-01T00:00:00Z', viewCount: 0, lastViewedAt: null, revokedAt: null, createdAt: '2026-10-24T00:00:00Z' };
    } else if (url.endsWith('/shares')) data = [existing];
    await route.fulfill({ json: { data } });
  };
  await page.route('**/api/v1/**', mockApi);
  await page.goto(`${BASE}/maps/demo`);
  await page.locator('g.wmind-topic').first().waitFor();
  await page.getByRole('button', { name: '分享', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '分享「产品规划」', exact: true });
  const password = dialog.getByRole('textbox', { name: '访问密码', exact: true });
  const expiry = dialog.getByRole('combobox', { name: '有效期', exact: true });
  const switches = dialog.getByRole('switch');
  await password.fill('draft-password');
  await expiry.click();
  await page.getByRole('option', { name: '30 天', exact: true }).click();
  for (const item of await switches.all()) if (await item.getAttribute('aria-checked') !== 'true') await item.click();
  const received = page.waitForResponse('**/api/v1/site/config');
  releaseConfig();
  await received;
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await password.inputValue(), 'draft-password', '站点配置异步返回不得清空已输入密码');
  assert.equal(await expiry.getAttribute('data-value'), '30');
  assert.equal(await switches.nth(0).getAttribute('aria-checked'), 'true');
  assert.equal(await switches.nth(1).getAttribute('aria-checked'), 'true');
  await dialog.getByRole('button', { name: '创建链接', exact: true }).click();
  await dialog.getByText('链接已创建，复制它发给对方：', { exact: true }).waitFor();
  assert.deepEqual(requests.at(-1), { password: 'draft-password', expiresInDays: 30, allowDownload: true, showNotes: true });
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '分享', exact: true }).click();
  assert.equal(await password.inputValue(), '');
  assert.equal(await expiry.getAttribute('data-value'), '7');
  assert.equal(await switches.nth(0).getAttribute('aria-checked'), 'false');
  assert.equal(await switches.nth(1).getAttribute('aria-checked'), 'false');
  assert.equal(await dialog.getByRole('switch', { name: '显示主题备注', exact: true }).count(), 1);
  await dialog.locator('li').filter({ hasText: '/s/existing-token' }).getByText('永久', { exact: true }).waitFor();
  const copy = await dialog.textContent();
  for (const removed of ['设了密码后', '不是访问控制', '服务端被剥掉', '响应里', '开发者工具']) assert.ok(!copy.includes(removed));
  await page.screenshot({ path: '/tmp/wmind-share-defaults.png' });
  await dialog.getByRole('button', { name: '创建链接', exact: true }).click();
  await dialog.getByText('链接已创建，复制它发给对方：', { exact: true }).waitFor();
  assert.deepEqual(requests.at(-1), { password: '', expiresInDays: 7, allowDownload: false, showNotes: false });
  // 显式管理员配置仍生效，异步默认只更新未编辑字段。
  config.shareDefaultExpireDays = 30;
  config.shareDefaultAllowDownload = true;
  configGate = new Promise((resolve) => { releaseConfig = resolve; });
  const custom = await browser.contexts()[0].newPage();
  custom.on('pageerror', (error) => errors.push(error.message));
  await custom.route('**/api/v1/**', mockApi);
  await custom.goto(`${BASE}/maps/demo`);
  await custom.locator('g.wmind-topic').first().waitFor();
  await custom.getByRole('button', { name: '分享', exact: true }).click();
  const customDialog = custom.getByRole('dialog', { name: '分享「产品规划」', exact: true });
  await customDialog.getByRole('textbox', { name: '访问密码', exact: true }).fill('another-password');
  const customConfig = custom.waitForResponse('**/api/v1/site/config');
  releaseConfig();
  await customConfig;
  await custom.waitForFunction(() => document.querySelector('dialog[open] [role="combobox"]')?.getAttribute('data-value') === '30');
  assert.equal(await customDialog.getByRole('textbox', { name: '访问密码', exact: true }).inputValue(), 'another-password');
  assert.equal(await customDialog.getByRole('switch', { name: '允许下载', exact: true }).getAttribute('aria-checked'), 'true');
  assert.equal(await customDialog.getByRole('switch', { name: '显示主题备注', exact: true }).getAttribute('aria-checked'), 'false');
  assert.deepEqual(errors, []);
  console.log('PASS: 配置异步保留草稿、明确选择提交、重开默认7天与关闭权限、管理员显式配置、已有链接、主题备注文案');
} finally { await browser.close(); }
