import assert from 'node:assert/strict';
import os from 'node:os';
import { chromium } from 'playwright-core';

// 完整接口夹具；不导入读取开发凭据的 harness，也不写入开发数据库。
const base = process.env.BASE ?? 'http://127.0.0.1:5173';
const executablePath = process.env.PLAYWRIGHT_CHROMIUM ?? `${os.homedir()}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const browser = await chromium.launch({ executablePath, args: ['--no-sandbox', '--font-render-hinting=none'] });
let checks = 0;
function check(name, pass) {
  assert.ok(pass, name);
  checks++;
  console.log(`[PASS] ${name}`);
}

try {
  for (const scenario of [
    { name: '管理员桌面', role: 'admin', width: 1440, version: '1.0.0', expected: 'v1.0.0' },
    { name: '普通用户移动端', role: 'user', width: 375, version: 'v1.0.0', expected: 'v1.0.0' },
    { name: '开发版窄屏', role: 'admin', width: 320, version: 'dev', expected: 'dev' },
    { name: '空版本回退', role: 'user', width: 768, version: '', expected: 'dev' },
    { name: '英文管理员', role: 'admin', width: 1440, locale: 'en-US', version: 'v1.2.3', expected: 'v1.2.3' },
    { name: '配置失败回退', role: 'user', width: 375, unavailable: true, expected: 'dev' },
  ]) {
    const context = await browser.newContext({ locale: scenario.locale ?? 'zh-CN', viewport: { width: scenario.width, height: 812 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    const requests = [];
    await page.route('**/api/v1/**', async (route) => {
      const path = new URL(route.request().url()).pathname.replace('/api/v1', '');
      requests.push(path);
      let data = [];
      if (path === '/auth/me' || path === '/auth/refresh') {
        data = { uid: 'version-user', username: 'version', nickname: '版本验收', email: '', role: scenario.role, status: 'active' };
        if (path === '/auth/refresh') data = { accessToken: 'fixture-token', expiresIn: 900, user: data };
      }
      if (path === '/site/config') {
        if (scenario.unavailable) return route.fulfill({ status: 503, json: { error: { code: 'INTERNAL_ERROR', message: '版本界面夹具' } } });
        data = { siteName: 'wmind', brand: 'wmind', passwordMinLength: 8, version: scenario.version };
      }
      if (path === '/auth/2fa/status') data = { enabled: false };
      await route.fulfill({ json: { data, pagination: { page: 1, pageSize: 20, total: 0, totalPages: 1 } } });
    });
    let failedConfigResponses = 0;
    const configSettled = scenario.unavailable ? page.waitForResponse((response) =>
      new URL(response.url()).pathname === '/api/v1/site/config' && response.status() === 503 && ++failedConfigResponses === 2) : Promise.resolve();
    await page.goto(`${base}/trash`);
    await configSettled;
    const english = scenario.locale === 'en-US';
    const trigger = page.getByRole('button', { name: english ? 'User menu' : '用户菜单', exact: true });
    await trigger.waitFor();
    await trigger.click();
    const menu = page.getByRole('menu', { name: english ? 'User menu' : '用户菜单', exact: true });
    const account = menu.locator('a[href="/account"]');
    const badge = account.locator('[data-app-version]');
    await badge.waitFor();
    await page.waitForFunction((expected) => document.querySelector('[data-app-version]')?.textContent === expected, scenario.expected);
    check(`${scenario.name}显示实际版本`, await badge.textContent() === scenario.expected && await menu.locator('[data-app-version]').count() === 1);
    check(`${scenario.name}保持原有菜单权限与焦点数量`, await menu.getByRole('menuitem').count() === (scenario.role === 'admin' ? 4 : 1)
      && await menu.locator('button, input, [tabindex="0"]').count() === 0
      && await account.evaluate((node) => node === document.activeElement));
    const geometry = await account.evaluate((node) => {
      const label = node.querySelector('span');
      const badge = node.querySelector('[data-app-version]');
      const left = label.getBoundingClientRect();
      const right = badge.getBoundingClientRect();
      const row = node.getBoundingClientRect();
      const popup = node.closest('[role="menu"]');
      const box = popup.getBoundingClientRect();
      return { aligned: right.left >= left.right && right.right <= row.right && Math.abs(right.top + right.height / 2 - left.top - left.height / 2) < 1,
        visible: box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight,
        noScroll: popup.clientHeight === popup.scrollHeight,
        badgeFont: getComputedStyle(badge).fontSize, labelFont: getComputedStyle(label).fontSize };
    });
    check(`${scenario.name}版本位于右侧且菜单完整可见`, geometry.aligned && geometry.visible && geometry.noScroll && geometry.badgeFont === '12px' && geometry.labelFont === '14px');
    await page.keyboard.press('End');
    check(`${scenario.name}键盘仍停在最后一个真实菜单项`, await menu.getByRole('menuitem').last().evaluate((node) => node === document.activeElement));
    await page.keyboard.press('Escape');
    check(`${scenario.name}关闭后焦点回到入口`, !await menu.isVisible() && await trigger.evaluate((node) => node === document.activeElement));
    await trigger.press('ArrowDown');
    await menu.waitFor();
    await page.keyboard.press('Enter');
    await page.waitForURL('**/account');
    check(`${scenario.name}个人设置仍可键盘导航`, !await menu.isVisible() && await page.getByRole('heading', { name: english ? 'Account' : '个人设置', exact: true }).count() === 1);
    const configRequests = requests.filter((path) => path === '/site/config').length;
    check(`${scenario.name}复用站点配置且无界面异常`, (scenario.unavailable ? configRequests >= 2 : configRequests === 1) && errors.length === 0);
    await context.close();
  }
  console.log(`\n合计 ${checks}/${checks} 通过`);
} finally {
  await browser.close();
}
