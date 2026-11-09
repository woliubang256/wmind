import { join } from 'node:path';
import { ADMIN, BASE, api, check, ensureUser, launchBrowser, login, makeUser, newPage, run, summary, uiLogin } from './lib/harness.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGMILZ/5H4QZYAwAUeIJkWvkWBUAAAAASUVORK5CYII=', 'base64');
const gravatar = 'https://www.gravatar.com/**';

run(async () => {
  const user = makeUser('avatars');
  const token = await ensureUser(user);
  const detail = (await api('/auth/me', { token })).data;
  const browser = await launchBrowser();
  try {
    const { page, errors } = await newPage(browser);
    let requests = 0;
    await page.route(gravatar, (route) => { requests++; return route.fulfill({ status: 404, body: '' }); });
    const missing = page.waitForResponse((res) => res.url().includes('gravatar.com/avatar/') && res.status() === 404);
    await uiLogin(page, user);
    await missing;
    const header = page.locator(`header [data-user-avatar="${detail.uid}"]`).first();
    await header.locator('img').waitFor({ state: 'detached' });
    const color = await header.evaluate((node) => getComputedStyle(node).backgroundColor);
    check('顶栏 Gravatar 不存在时显示首字符和彩色背景', await header.textContent() === 'A' && color !== 'rgba(0, 0, 0, 0)');
    await page.goto(`${BASE}/account`);
    const all = page.locator(`[data-user-avatar="${detail.uid}"]`);
    await all.nth(1).waitFor();
    check('顶栏与个人设置共用首字符和颜色', await all.count() === 2 && (await all.evaluateAll((nodes) => nodes.every((node) => getComputedStyle(node).backgroundColor === getComputedStyle(nodes[0]).backgroundColor))));
    await page.reload();
    check('刷新后背景颜色保持', await header.evaluate((node) => getComputedStyle(node).backgroundColor) === color);
    await api('/users/me', { method: 'PATCH', token, body: { nickname: '张三' } });
    await page.reload();
    check('中文昵称使用首字符，颜色不随昵称变化', await header.textContent() === '张' && await header.evaluate((node) => getComputedStyle(node).backgroundColor) === color);

    await page.unroute(gravatar);
    await page.route(gravatar, (route) => { requests++; return route.fulfill({ contentType: 'image/png', body: png }); });
    await page.reload();
    await page.waitForFunction(() => [...document.querySelectorAll('[data-user-avatar] img')].length >= 2 && [...document.querySelectorAll('[data-user-avatar] img')].every((img) => img.naturalWidth > 0));
    const url = await header.locator('img').getAttribute('src');
    check('默认头像使用邮箱摘要 Gravatar，设置页同步', /^https:\/\/www\.gravatar\.com\/avatar\/[a-f0-9]{64}\?/.test(url) && await all.nth(1).locator('img').getAttribute('src') === url);
    check('外部头像请求不带 Referer', await header.locator('img').getAttribute('referrerpolicy') === 'no-referrer');

    const uploadResponse = page.waitForResponse((res) => res.url().includes('/users/me/avatar'));
    await page.locator('input[type="file"]').setInputFiles({ name: 'avatar.png', mimeType: 'image/png', buffer: png });
    const uploadedResponse = await uploadResponse;
    if (uploadedResponse.status() !== 200) throw new Error(`上传失败：${await uploadedResponse.text()}`);
    await header.locator('img[src^="/uploads/"]').waitFor();
    const uploaded = await header.locator('img').getAttribute('src');
    check('手动上传立即覆盖默认头像并同步两处', await all.nth(1).locator('img').getAttribute('src') === uploaded);
    const previousRequests = requests;
    await page.reload();
    await header.locator('img[src^="/uploads/"]').waitFor();
    check('刷新保留手动头像，且不请求 Gravatar 图片', await header.locator('img').getAttribute('src') === uploaded && requests === previousRequests);
    await page.route('**/uploads/avatar_*.png', (route) => route.abort());
    await page.reload();
    await header.locator('img[src*="gravatar.com"]').waitFor();
    check('手动头像加载失败可回退 Gravatar', await header.locator('img').getAttribute('src') === url);
    await page.unroute(gravatar);
    await page.route(gravatar, (route) => route.fulfill({ status: 404, body: '' }));
    const failed = page.waitForResponse((res) => res.url().includes('gravatar.com/avatar/') && res.status() === 404);
    await page.reload();
    await failed;
    await header.locator('img').waitFor({ state: 'detached' });
    check('两种来源均失败时回退首字符，避免裂图', await header.textContent() === '张');
    await page.unroute('**/uploads/avatar_*.png');
    await page.reload();
    await header.locator('img[src^="/uploads/"]').waitFor();
    check('失败回退不改写已保存的手动头像', (await api('/auth/me', { token })).data.avatarUrl === uploaded);
    if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.SCREENSHOT_DIR, 'wmind-avatars.png') });

    const adminToken = await login(ADMIN.email, ADMIN.password);
    const adminPage = (await newPage(browser, { context: await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' }), errors })).page;
    await uiLogin(adminPage, ADMIN);
    await adminPage.goto(`${BASE}/admin/users`);
    await adminPage.getByRole('textbox').first().fill(user.username);
    await adminPage.getByRole('textbox').first().press('Enter');
    await adminPage.locator(`table [data-user-avatar="${detail.uid}"] img`).waitFor();
    check('管理用户列表也保留手动头像', await adminPage.locator(`table [data-user-avatar="${detail.uid}"] img`).getAttribute('src') === uploaded);
    check('头像交互没有浏览器异常', errors.length === 0, errors.join('\n'));
    await api(`/admin/users/${detail.uid}?map_strategy=delete`, { method: 'DELETE', token: adminToken });
    if (!summary()) process.exitCode = 1;
  } finally { await browser.close(); }
});
