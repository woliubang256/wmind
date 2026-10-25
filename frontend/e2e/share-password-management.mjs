/** Fully mocked owner workflow. Never creates real users or share links. */
import assert from 'node:assert/strict';
import { BASE, launchBrowser } from './lib/harness.mjs';

const browser = await launchBrowser();
try {
  const context = browser.contexts()[0];
  const errors = [];
  const posts = [];
  const patches = [];
  const link = (uid, password, extra = {}) => ({ uid, token: uid, url: `/s/${uid}`, mapUid: 'demo', mapTitle: '产品规划',
    hasPassword: !!password, password, allowDownload: false, showNotes: false, expiresAt: null, viewCount: 1,
    lastViewedAt: null, revokedAt: null, createdAt: '2026-10-25T00:00:00Z', ...extra });
  const links = [link('new-password', 'Ab9x'), link('legacy', null, { hasPassword: true }), link('open', null),
    link('revoked', 'Zz7p', { revokedAt: '2026-10-25T01:00:00Z' })];
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => { window.__copied = text; } } });
  });
  await context.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    let data = {};
    let pagination;
    if (path.endsWith('/auth/refresh') || path.endsWith('/auth/me')) {
      const user = { uid: 'fixture-user', username: '测试用户', email: 'test@example.test', role: 'user', status: 'active', settings: {} };
      data = path.endsWith('/auth/refresh') ? { accessToken: 'fixture-token', expiresIn: 900, user } : user;
    } else if (path.endsWith('/site/config')) {
      data = { siteName: 'wmind', shareEnabled: true, exportEnabled: true, shareDefaultExpireDays: 7, shareDefaultAllowDownload: false, passwordMinLength: 32 };
    } else if (path.endsWith('/shares') && req.method() === 'POST') {
      const input = req.postDataJSON();
      posts.push(input);
      data = link(`created-${posts.length}`, input.password || null);
      links.unshift(data);
    } else if (req.method() === 'PATCH' && path.includes('/shares/')) {
      const uid = path.split('/').at(-1);
      const input = req.postDataJSON();
      patches.push({ uid, ...input });
      const item = links.find((entry) => entry.uid === uid);
      if (input.password === 'bad') return route.fulfill({ status: 422, json: { error: { code: 'VALIDATION_FAILED', message: '访问密码至少4位', details: { fields: { password: '访问密码至少4位' } } } } });
      Object.assign(item, { password: input.password, hasPassword: !!input.password });
      data = item;
    } else if (path.endsWith('/shares')) {
      data = links;
      if (path === '/api/v1/shares') pagination = { page: 1, pageSize: 20, total: links.length, totalPages: 1 };
    }
    await route.fulfill({ json: { data, ...(pagination ? { pagination } : {}) } });
  });

  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${BASE}/maps/demo`);
  await page.locator('g.wmind-topic').first().waitFor();
  await page.getByRole('button', { name: '分享', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '分享「产品规划」', exact: true });
  const password = dialog.getByRole('textbox', { name: '访问密码', exact: true });
  assert.equal(await password.inputValue(), '', 'manual/no-password remains possible');
  await dialog.getByRole('button', { name: '随机生成', exact: true }).click();
  const generated = await password.inputValue();
  assert.match(generated, /^[A-Za-z0-9]{4}$/);
  for (const pattern of [/[a-z]/, /[A-Z]/, /[0-9]/]) assert.match(generated, pattern);
  await dialog.getByRole('button', { name: '创建链接', exact: true }).click();
  await dialog.getByText('链接已创建', { exact: true }).waitFor();
  assert.equal(posts[0].password, generated, 'account minLength=32 must not affect sharing');
  const created = dialog.locator('[data-share-password="created-1"]');
  await created.getByText(generated, { exact: true }).waitFor();
  await created.getByRole('button', { name: '复制密码', exact: true }).click();
  assert.equal(await page.evaluate(() => window.__copied), generated);
  assert.equal(await dialog.locator('li').filter({ hasText: '/s/open' }).getByRole('button', { name: '重设密码', exact: true }).count(), 0);
  assert.equal(await dialog.locator('[data-share-password="revoked"]').getByRole('button', { name: '重设密码', exact: true }).count(), 0);
  await dialog.locator('[data-share-password="legacy"]').getByText('原密码不可查看', { exact: true }).waitFor();
  await dialog.locator('[data-share-password="legacy"]').getByRole('button', { name: '重设密码', exact: true }).click();
  const reset = page.getByRole('dialog', { name: '重设密码', exact: true });
  await reset.getByRole('textbox', { name: '访问密码', exact: true }).fill('bad');
  await reset.getByRole('button', { name: '保存', exact: true }).click();
  await reset.getByRole('alert').waitFor();
  await reset.getByRole('button', { name: '随机生成', exact: true }).click();
  const resetPassword = await reset.getByRole('textbox', { name: '访问密码', exact: true }).inputValue();
  await reset.getByRole('button', { name: '保存', exact: true }).click();
  await reset.waitFor({ state: 'hidden' });
  await dialog.locator('[data-share-password="legacy"]').getByText(resetPassword, { exact: true }).waitFor();
  assert.deepEqual(patches.at(-1), { uid: 'legacy', password: resetPassword });
  // Native-dialog clipboard fallback must operate inside the top modal.
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    document.execCommand = (command) => {
      const area = document.querySelector('dialog[open] textarea');
      window.__copied = area?.value;
      return command === 'copy' && !!area;
    };
  });
  await created.getByRole('button', { name: '复制密码', exact: true }).click();
  assert.equal(await page.evaluate(() => window.__copied), generated);
  assert.equal(await dialog.locator('textarea').count(), 0, 'fallback clears temporary plaintext');
  await page.screenshot({ path: '/tmp/wmind-share-password-desktop.png' });
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();

  await page.goto(`${BASE}/shares`);
  await page.locator('[data-share-password="legacy"]').getByText(resetPassword, { exact: true }).waitFor();
  await page.reload();
  await page.locator('[data-share-password="legacy"]').getByText(resetPassword, { exact: true }).waitFor();
  await page.locator('[data-share-password="legacy"]').getByRole('button', { name: '重设密码', exact: true }).click();
  await reset.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(patches.length, 2, 'cancel must not save');
  await page.locator('[data-share-password="legacy"]').getByRole('button', { name: '重设密码', exact: true }).click();
  await reset.getByRole('button', { name: '保存', exact: true }).click();
  await reset.waitFor({ state: 'hidden' });
  assert.deepEqual(patches.at(-1), { uid: 'legacy', password: null });
  await page.waitForFunction(() => !document.querySelector('[data-share-password="legacy"]'));

  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`${BASE}/maps/demo`);
  await page.locator('g.wmind-topic').first().waitFor();
  await page.getByRole('button', { name: '分享', exact: true }).click();
  await dialog.getByRole('button', { name: '随机生成', exact: true }).click();
  assert.match(await password.inputValue(), /^[A-Za-z0-9]{4}$/);
  assert.equal(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth), true, '375px dialog must not overflow');
  await page.screenshot({ path: '/tmp/wmind-share-password-mobile.png' });
  assert.equal(await page.evaluate((secret) => [localStorage, sessionStorage].some((store) => Object.values(store).some((value) => value.includes(secret))), generated), false, 'password must not be persisted in browser storage');
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await page.evaluate(() => localStorage.setItem('wmind:locale', 'en-US'));
  await page.goto(`${BASE}/shares`);
  await page.getByRole('heading', { name: 'My shares', exact: true }).waitFor();
  await page.locator('[data-share-password="created-1"]').getByRole('button', { name: 'Reset password', exact: true }).click();
  const english = page.getByRole('dialog', { name: 'Reset password', exact: true });
  await english.getByRole('button', { name: 'Generate', exact: true }).click();
  assert.match(await english.getByRole('textbox', { name: 'Access password', exact: true }).inputValue(), /^[A-Za-z0-9]{4}$/);
  assert.equal(await english.evaluate((node) => node.scrollWidth <= node.clientWidth), true);
  await page.screenshot({ path: '/tmp/wmind-share-password-en-mobile.png' });
  await english.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.deepEqual(errors, []);
  console.log('PASS: 4位三类随机密码 / 账号策略隔离 / 两处查看复制与重设 / 旧哈希 / 失败与取消 / 刷新 / 无密码 / dialog复制降级 / 中英文375px / 无密码持久化');
} finally { await browser.close(); }
