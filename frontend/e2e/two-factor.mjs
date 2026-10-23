import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { BASE, api, check, ensureUser, launchBrowser, makeUser, newPage, run, summary, uiLogin } from './lib/harness.mjs';

function totp(secret) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = '';
  for (const c of secret) bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g).map((s) => parseInt(s, 2)));
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const mac = createHmac('sha1', key).update(counter).digest(); const offset = mac[19] & 15;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}
run(async () => {
  const user = makeUser('twofactor'); const oldToken = await ensureUser(user);
  const browser = await launchBrowser();
  try {
    const { page, errors } = await newPage(browser);
    await uiLogin(page, user); await page.goto(`${BASE}/account`);
    const settings = page.locator('[data-two-factor-settings]');
    await settings.getByRole('button', { name: '设置双因素认证', exact: true }).click();
    await settings.getByLabel('当前密码', { exact: true }).fill(user.password);
    await settings.getByRole('button', { name: '生成二维码', exact: true }).click();
    const secret = await settings.getByLabel('手动输入密钥').inputValue();
    assert.ok(secret.length >= 32);
    assert.match(await settings.getByAltText('验证器设置二维码').getAttribute('src'), /^data:image\/png;base64,/);
    const stillDisabled = await api('/auth/2fa/status', { token: oldToken }); assert.equal(stillDisabled.data.enabled, false);
    check('账户设置提供二维码和手动密钥，验证前尚未启用', true);
    await settings.getByLabel('验证器验证码', { exact: true }).fill(totp(secret));
    await settings.getByRole('button', { name: '验证并启用', exact: true }).click();
    const codeList = settings.locator('[data-recovery-codes]'); await codeList.waitFor();
    const recovery = (await codeList.textContent()).trim().split('\n'); assert.equal(recovery.length, 10);
    const downloadEvent = page.waitForEvent('download'); await settings.getByRole('button', { name: '下载恢复码', exact: true }).click();
    const download = await downloadEvent; assert.ok(readFileSync(await download.path(), 'utf8').includes(recovery[0]));
    await settings.getByRole('button', { name: '已保存恢复码', exact: true }).click();
    assert.equal(await codeList.count(), 0);
    assert.equal((await api('/auth/me', { token: oldToken, raw: true })).status, 401);
    check('启用显示一次恢复码并可下载，旧访问令牌立即失效', true);
    const logout = async () => { await page.getByRole('button', { name: '退出登录', exact: true }).click(); await page.waitForURL('**/login'); };
    const firstStep = async () => {
      await page.getByLabel('用户名或邮箱').fill(user.email); await page.getByLabel('密码', { exact: true }).fill(user.password);
      await page.getByRole('button', { name: '登录', exact: true }).click(); await page.getByLabel('验证器验证码', { exact: true }).waitFor();
      assert.match(page.url(), /\/login$/);
      assert.equal((await page.context().cookies()).filter((cookie) => cookie.name === 'wmind_refresh').length, 0);
    };
    await logout(); await firstStep();
    await page.getByRole('button', { name: '使用恢复码', exact: true }).click();
    await page.getByLabel('恢复码', { exact: true }).fill('invalid'); await page.getByRole('button', { name: '验证并登录', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '验证码无效' }).waitFor(); assert.match(page.url(), /\/login$/);
    await page.getByLabel('恢复码', { exact: true }).fill(recovery[0]); await page.getByRole('button', { name: '验证并登录', exact: true }).click();
    await page.waitForURL((url) => !url.pathname.startsWith('/login'));
    check('密码步骤没有会话，错误恢复码不放行，有效恢复码可登录', true);
    await logout(); await firstStep();
    // Enabling consumed the current TOTP counter; wait for a fresh counter.
    await page.waitForTimeout(30050 - Date.now() % 30000);
    await page.getByLabel('验证器验证码', { exact: true }).fill(totp(secret));
    await page.getByRole('button', { name: '验证并登录', exact: true }).click(); await page.waitForURL((url) => !url.pathname.startsWith('/login'));
    check('真实 TOTP 验证码完成第二步登录', true);
    await page.goto(`${BASE}/account`);
    await settings.getByRole('button', { name: '重新生成恢复码', exact: true }).click();
    await settings.getByLabel('当前密码', { exact: true }).fill(user.password);
    await settings.getByLabel('验证码或恢复码').fill(recovery[0]); await settings.getByRole('button', { name: '提交', exact: true }).click();
    await settings.getByRole('alert').waitFor(); assert.equal(await codeList.count(), 0);
    await settings.getByLabel('验证码或恢复码').fill(recovery[1]); await settings.getByRole('button', { name: '提交', exact: true }).click();
    await codeList.waitFor(); const newCodes = (await codeList.textContent()).trim().split('\n'); assert.equal(newCodes.length, 10); assert.notEqual(newCodes[0], recovery[0]);
    check('已消费的恢复码不能重放，新恢复码替换旧码', true);
    await settings.getByRole('button', { name: '已保存恢复码', exact: true }).click();
    await settings.getByRole('button', { name: '停用双因素认证', exact: true }).click();
    await settings.getByLabel('当前密码', { exact: true }).fill(user.password);
    await settings.getByLabel('验证码或恢复码').fill(newCodes[0]); await settings.getByRole('button', { name: '提交', exact: true }).click();
    await settings.getByRole('status').filter({ hasText: '尚未启用' }).waitFor();
    check('密码和第二因子确认后停用，当前设备继续可用', true);
    await page.getByRole('combobox', { name: '界面语言', exact: true }).click();
    await page.getByRole('option', { name: 'English', exact: true }).click();
    await settings.getByRole('button', { name: 'Set up two-factor authentication', exact: true }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await settings.scrollIntoViewIfNeeded();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    check('2FA 中英文界面与窄屏布局正常', true);
    if (process.env.SCREENSHOT_PATH) {
      await settings.scrollIntoViewIfNeeded(); await page.screenshot({ path: process.env.SCREENSHOT_PATH });
    }
    check('没有浏览器异常', errors.length === 0, errors.join('\n'));
    return summary();
  } finally { await browser.close(); }
});
