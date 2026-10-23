import { join } from 'node:path';
import { BASE, check, ensureUser, launchBrowser, makeUser, newPage, run, summary, uiLogin, waitForCanvas } from './lib/harness.mjs';

run(async () => {
  const user = makeUser('zoom');
  await ensureUser(user);
  const browser = await launchBrowser();
  try {
    const { page, errors } = await newPage(browser);
    await uiLogin(page, user);
    await page.goto(`${BASE}/maps/demo`);
    await waitForCanvas(page);
    const trigger = page.getByRole('combobox', { name: '快捷缩放', exact: true });
    const menu = page.getByRole('listbox', { name: '快捷缩放', exact: true });
    const viewport = () => page.locator('svg[data-read-only] > g').first().evaluate((node) => {
      const matrix = node.transform.baseVal.consolidate().matrix;
      const rect = node.ownerSVGElement.getBoundingClientRect();
      return { zoom: matrix.a, x: (rect.width / 2 - matrix.e) / matrix.a, y: (rect.height / 2 - matrix.f) / matrix.a };
    });
    const before = await viewport();
    await trigger.click();
    await menu.waitFor({ state: 'visible' });
    const options = await menu.getByRole('option').allTextContents();
    const placement = await menu.boundingBox();
    const button = await trigger.boundingBox();
    check('六档比例顺序正确，菜单在缩放入口上方', options.join(',') === '50%,75%,100%,125%,150%,200%' && placement.y + placement.height <= button.y, JSON.stringify({ options, placement, button }));
    if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.SCREENSHOT_DIR, 'wmind-zoom-menu.png') });
    for (const percent of [50, 75, 100, 125, 150, 200]) {
      if (!await menu.isVisible()) await trigger.click();
      await menu.getByRole('option', { name: `${percent}%`, exact: true }).click();
      const after = await viewport();
      check(`${percent}% 生效并保持画布中心，选择后收起`, Math.abs(after.zoom - percent / 100) < 1e-6 && Math.abs(after.x - before.x) < 0.001 && Math.abs(after.y - before.y) < 0.001 && !await menu.isVisible() && await trigger.textContent() === `缩放 ${percent}%`);
    }
    await trigger.click();
    check('当前比例显示勾选', await menu.getByRole('option', { selected: true }).textContent() === '200%');
    await page.keyboard.press('Escape');
    check('Esc 关闭并还焦点', !await menu.isVisible() && await trigger.evaluate((node) => node === document.activeElement));
    await trigger.press('ArrowUp');
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    check('键盘可选择 75%', Math.abs((await viewport()).zoom - 0.75) < 1e-6);
    await trigger.click();
    await page.locator('footer').getByText(/个节点/).click();
    check('外部点击关闭', !await menu.isVisible());
    await page.getByRole('button', { name: '放大', exact: true }).click();
    await trigger.click();
    check('任意比例读数保留，不冒充预设档位', await trigger.textContent() === '缩放 90%' && await menu.getByRole('option', { selected: true }).count() === 0);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '只读预览', exact: true }).click();
    await trigger.click();
    await menu.getByRole('option', { name: '125%', exact: true }).click();
    check('只读预览也可快捷缩放', Math.abs((await viewport()).zoom - 1.25) < 1e-6);
    await page.getByRole('button', { name: '退出预览', exact: true }).click();
    await page.getByRole('button', { name: '大纲视图', exact: true }).first().click();
    check('大纲没有画布时禁用缩放入口', await trigger.isDisabled());
    await page.getByRole('button', { name: '大纲视图', exact: true }).first().click();
    await page.setViewportSize({ width: 375, height: 812 });
    await trigger.click();
    const narrow = await menu.boundingBox();
    check('窄屏菜单不超出视口', narrow.x >= 0 && narrow.x + narrow.width <= 375 && narrow.y >= 0 && narrow.y + narrow.height <= 812);
    check('快捷缩放没有浏览器异常', errors.length === 0, errors.join('\n'));
    if (!summary()) process.exitCode = 1;
  } finally { await browser.close(); }
});
