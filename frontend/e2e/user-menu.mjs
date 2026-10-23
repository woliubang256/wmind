import { join } from 'node:path';
import { ADMIN, BASE, api, check, ensureUser, launchBrowser, login, makeUser, newContext, newPage, run, summary, uiLogin } from './lib/harness.mjs';

const menuLabels = (menu) => menu.getByRole('menuitem').evaluateAll((items) => items.map((item) => item.querySelector('span')?.textContent));

run(async () => {
  const browser = await launchBrowser();
  let testUser;
  let adminToken;
  try {
    const { page, errors } = await newPage(browser);
    await page.route('https://www.gravatar.com/**', (route) => route.fulfill({ status: 404, body: '' }));
    await uiLogin(page, ADMIN);
    await page.goto(`${BASE}/templates`);
    const trigger = page.getByRole('button', { name: '用户菜单', exact: true });
    const menu = page.getByRole('menu', { name: '用户菜单', exact: true });
    await trigger.waitFor();
    check('主导航仅保留最近、模板、分享和回收站', await page.getByRole('navigation', { name: '主导航' }).getByRole('link').count() === 4);
    check('用户入口有头像和向下箭头', await trigger.locator('[data-user-avatar]').count() === 1 && await trigger.locator('svg').count() === 1);
    await trigger.click();
    await menu.waitFor();
    check('管理员的四项入口收入菜单且每项有图标', (await menuLabels(menu)).join(',') === '个人设置,管理概览,用户管理,网站设置' && await menu.getByRole('menuitem').locator('svg').count() === 4);
    const rect = await menu.boundingBox();
    const anchor = await trigger.boundingBox();
    check('菜单位于用户入口下方且不超出屏幕', rect.y >= anchor.y + anchor.height && rect.x >= 0 && rect.x + rect.width <= 1440);
    check('打开后首项获得键盘焦点', await menu.getByRole('menuitem').first().evaluate((node) => node === document.activeElement));
    if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.SCREENSHOT_DIR, 'wmind-user-menu.png') });
    await menu.getByRole('menuitem', { name: '用户管理', exact: true }).click();
    await page.waitForURL('**/admin/users');
    check('选择菜单项导航并自动收起', !await menu.isVisible());
    await trigger.click();
    await menu.waitFor();
    check('当前页仅高亮用户管理', await menu.locator('[aria-current="page"]').count() === 1 && await menu.locator('[aria-current="page"]').textContent() === '用户管理');
    await page.keyboard.press('Escape');
    check('Esc 关闭并将焦点还给用户入口', !await menu.isVisible() && await trigger.evaluate((node) => node === document.activeElement));
    await trigger.press('ArrowUp');
    await menu.waitFor();
    check('向上键从最后一项打开', await menu.getByRole('menuitem').last().evaluate((node) => node === document.activeElement));
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.waitForURL('**/admin');
    check('Home、方向键与 Enter 可完成导航', !await menu.isVisible());
    await trigger.click();
    await menu.waitFor();
    await page.getByRole('heading', { level: 1 }).click();
    check('点击外部关闭菜单', !await menu.isVisible());
    await trigger.click();
    await menu.waitFor();
    await page.keyboard.press('Tab');
    check('Tab 离开时关闭菜单', !await menu.isVisible());
    for (const width of [320, 375, 768]) {
      await page.setViewportSize({ width, height: 812 });
      await trigger.click();
      await menu.waitFor();
      const popup = await menu.boundingBox();
      const controls = await page.locator('header').first().locator('button:visible, [role="combobox"]:visible').evaluateAll((nodes) => nodes.map((node) => {
        const r = node.getBoundingClientRect(); return { left: r.left, right: r.right };
      }));
      check(`${width}px 菜单和顶栏操作完整可见`, popup.x >= 0 && popup.x + popup.width <= width && controls.every((r) => r.left >= 0 && r.right <= width));
      if (width === 375 && process.env.SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.SCREENSHOT_DIR, 'wmind-user-menu-mobile.png') });
      await page.keyboard.press('Escape');
    }
    await page.setViewportSize({ width: 375, height: 812 });
    await page.getByRole('button', { name: '菜单', exact: true }).click();
    const drawer = page.getByRole('dialog', { name: '菜单', exact: true });
    await drawer.waitFor();
    check('移动导航抽屉不再重复用户和管理入口', await drawer.getByRole('link').count() === 4 && await drawer.getByRole('link', { name: '个人设置', exact: true }).count() === 0);
    await drawer.getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByRole('combobox', { name: '界面语言', exact: true }).click();
    await page.getByRole('option', { name: 'English', exact: true }).click();
    const englishTrigger = page.getByRole('button', { name: 'User menu', exact: true });
    await englishTrigger.click();
    const english = page.getByRole('menu', { name: 'User menu', exact: true });
    await english.waitFor();
    check('用户菜单完整支持英文', (await menuLabels(english)).join(',') === 'Account,Overview,Users,Site settings');
    await page.keyboard.press('Escape');
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    await englishTrigger.click();
    await english.waitFor();
    const theme = await english.evaluate((node) => ({ bg: getComputedStyle(node).backgroundColor, color: getComputedStyle(node).color }));
    check('深色菜单使用主题背景与文字', theme.bg !== 'rgb(255, 255, 255)' && theme.bg !== theme.color);
    await page.keyboard.press('Escape');

    const user = makeUser('usermenu');
    const token = await ensureUser(user);
    testUser = (await api('/auth/me', { token })).data;
    const regular = (await newPage(browser, { context: await newContext(browser), errors })).page;
    await regular.route('https://www.gravatar.com/**', (route) => route.fulfill({ status: 404, body: '' }));
    await uiLogin(regular, user);
    await regular.getByRole('button', { name: '用户菜单', exact: true }).click();
    const regularMenu = regular.getByRole('menu', { name: '用户菜单', exact: true });
    await regularMenu.waitFor();
    check('普通用户只显示个人设置，没有管理员菜单', (await menuLabels(regularMenu)).join(',') === '个人设置');
    await regularMenu.getByRole('menuitem').click();
    await regular.waitForURL('**/account');
    check('普通用户可从用户菜单进入个人设置', !await regularMenu.isVisible());
    await regular.goto(`${BASE}/admin/users`);
    await regular.waitForURL(`${BASE}/`);
    check('普通用户直接访问管理页仍受路由权限保护', new URL(regular.url()).pathname === '/');
    check('用户菜单没有浏览器异常', errors.length === 0, errors.join('\n'));
    if (!summary()) process.exitCode = 1;
  } finally {
    await browser.close();
    if (testUser) {
      adminToken = await login(ADMIN.email, ADMIN.password);
      await api(`/admin/users/${testUser.uid}?map_strategy=delete`, { method: 'DELETE', token: adminToken });
    }
  }
});
