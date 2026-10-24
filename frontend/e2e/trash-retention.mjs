import assert from 'node:assert/strict';
import os from 'node:os';
import { chromium } from 'playwright-core';

// All requests are fixtures; no accounts or maps are written to the development DB.
const base = process.env.BASE ?? 'http://127.0.0.1:5199';
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM ?? `${os.homedir()}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing` });
let checks = 0;
const pass = (name) => { checks++; console.log(`[PASS] ${name}`); };
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' });
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  const now = Date.parse('2026-10-24T12:00:00.500Z');
  await page.clock.install({ time: new Date(now) });
  await page.clock.setFixedTime(new Date(now));
  let settings = { 'trash.retention_days': 30 };
  let patch;
  let retained = true;
  let reads = 0;
  const detail = (uid, title, expiresAt) => ({ uid, title, expiresAt, deleted: true, deletedAt: new Date(now - 1000).toISOString(), updatedAt: '2020-01-01T00:00:00Z', createdAt: '2020-01-01T00:00:00Z', thumbnailUrl: '', nodeCount: 1, sizeBytes: 100, version: 1 });
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace('/api/v1', '');
    let data = [];
    if (path.startsWith('/admin/backup')) return route.fulfill({ status: 503, json: { error: { code: 'INTERNAL_ERROR', message: 'Backups are not part of this fixture' } } });
    if (path === '/auth/me' || path === '/auth/refresh') {
      data = { uid: 'trash-admin', username: 'admin', nickname: '管理员', email: '', role: 'admin', status: 'active' };
      if (path === '/auth/refresh') data = { accessToken: 'fixture-token', expiresIn: 900, user: data };
    }
    if (path === '/site/config') data = { siteName: 'wmind', shareEnabled: true };
    if (path === '/auth/2fa/status') data = { enabled: false };
    if (path === '/admin/settings') {
      if (request.method() === 'PUT') { patch = request.postDataJSON(); settings = { ...settings, ...patch }; }
      data = settings;
    }
    if (path === '/trash') {
      reads++;
      data = [
        ...(retained ? [detail('retained', '默认期限', new Date(now + settings['trash.retention_days'] * 86400000).toISOString())] : []),
        detail('rounded', '向上取整', new Date(now + 86400001).toISOString()),
        detail('soon', '即将到期', new Date(now + 30000).toISOString()),
        detail('expired', '已经到期', new Date(now - 1).toISOString()),
        detail('unknown', '缺失期限', undefined),
      ];
    }
    if (path === '/trash/retained/restore') { retained = false; data = { ...detail('retained', '默认期限'), deleted: false }; }
    return route.fulfill({ json: { data, pagination: { page: 1, pageSize: 24, total: Array.isArray(data) ? data.length : 0, totalPages: 1 } } });
  });
  await page.goto(`${base}/trash`);
  const card = (title) => page.getByRole('article').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
  await card('默认期限').waitFor();
  assert.match(await card('默认期限').textContent(), /30 天后删除/);
  assert.ok(!(await card('默认期限').textContent()).includes('删除于'));
  pass('按服务端到期时间显示30天，替换旧删除时间文案');
  assert.match(await card('向上取整').textContent(), /2 天后删除/);
  assert.match(await card('即将到期').textContent(), /1 天后删除/);
  pass('剩余天数向上取整，不依赖更新时间');
  assert.match(await card('已经到期').textContent(), /即将删除/);
  assert.match(await card('缺失期限').textContent(), /删除时间暂不可用/);
  pass('到期及缺少期限有准确状态');
  await page.clock.setFixedTime(new Date(now + 60_000));
  await page.clock.fastForward(60_000);
  await page.waitForFunction(() => [...document.querySelectorAll('article')].some((node) => node.textContent.includes('即将到期') && node.textContent.includes('即将删除')));
  pass('页面停留时每分钟更新倒计时并刷新列表');
  await card('默认期限').getByRole('button', { name: '恢复', exact: true }).click();
  await card('默认期限').waitFor({ state: 'detached' });
  pass('恢复后从回收站移除');

  await page.getByRole('button', { name: '用户菜单', exact: true }).click();
  await page.getByRole('menuitem', { name: '网站设置', exact: true }).click();
  const input = page.getByRole('spinbutton', { name: '回收站保留天数', exact: true });
  await input.waitFor();
  assert.equal(await input.inputValue(), '30');
  assert.equal(await input.getAttribute('min'), '1');
  assert.equal(await input.getAttribute('max'), '3650');
  assert.ok(await page.getByText(/缩短期限可能在下一次清理时永久删除/).count());
  pass('全局设置默认30天，显示范围与缩短期限的影响');
  await input.fill('0');
  assert.equal(await input.evaluate((node) => node.checkValidity()), false);
  assert.equal(patch, undefined);
  pass('0天无法通过输入校验，不发送设置');
  await input.fill('7');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await page.waitForFunction(() => document.body.innerText.includes('已保存'));
  assert.deepEqual(patch, { 'trash.retention_days': 7 });
  pass('设置只提交修改过的全局保留天数');
  retained = true;
  const before = reads;
  await page.getByRole('link', { name: '回收站', exact: true }).first().click();
  await card('默认期限').waitFor();
  assert.match(await card('默认期限').textContent(), /7 天后删除/);
  assert.ok(reads > before);
  pass('修改设置后回收站重新拉取，已有内容使用新期限');
  await page.locator('header').getByRole('combobox').click();
  await page.getByRole('option', { name: 'English', exact: true }).click();
  await page.waitForFunction(() => document.body.innerText.includes('Deletes in 7 days'));
  assert.match(await card('默认期限').textContent(), /Deletes in 7 days/);
  pass('英文状态文案正常切换');
  assert.deepEqual(errors, []);
  pass('无浏览器异常');
  console.log(`\n回收站保留期限 ${checks}/${checks} 通过`);
} finally { await browser.close(); }
