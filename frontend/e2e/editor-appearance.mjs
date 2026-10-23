import { join } from 'node:path';
import {
  BASE, api, check, ensureUser, launchBrowser, makeUser, newPage, run, summary, uiLogin, waitForCanvas,
} from './lib/harness.mjs';

const font = (locator) => locator.evaluate((node) => {
  const style = getComputedStyle(node);
  return { size: style.fontSize, weight: style.fontWeight, lineHeight: style.lineHeight };
});

run(async () => {
  const user = makeUser('appearance');
  const token = await ensureUser(user);
  const browser = await launchBrowser();
  let uid;
  try {
    const { page, errors } = await newPage(browser);
    await page.goto(`${BASE}/login`);
    const login = await font(page.getByRole('button', { name: '登录', exact: true }));
    check('普通表单按钮保留 14px 和中等字重', login.size === '14px' && login.weight === '500', JSON.stringify(login));
    await uiLogin(page, user);
    await page.getByRole('button', { name: '新建导图', exact: true }).first().click();
    await page.locator('dialog[open]').getByRole('button', { name: /思维导图/ }).first().click();
    await page.waitForURL((url) => url.pathname.startsWith('/maps/'));
    uid = page.url().split('/maps/')[1].split(/[?#]/)[0];
    await waitForCanvas(page);
    const panel = page.getByRole('complementary', { name: '画布面板', exact: true });
    // 依据实际浏览器计算值，不能只检查 text-xs 类名是否存在。
    for (const dark of [false, true]) {
      await page.evaluate((value) => document.documentElement.classList.toggle('dark', value), dark);
      await page.getByRole('tab', { name: '样式', exact: true }).click();
      const tab = await font(page.getByRole('tab', { name: '样式', exact: true }));
      const select = await font(panel.getByRole('combobox', { name: '字体', exact: true }));
      const auxiliary = await font(panel.getByRole('button', { name: '继承主题', exact: true }).first());
      const checkbox = await font(panel.getByRole('checkbox', { name: '按内容自适应宽度', exact: true }));
      const width = await font(panel.getByRole('spinbutton').first());
      check(`${dark ? '深色' : '浅色'}侧栏：页签和下拉 12px，辅助按钮 11px，输入及复选框 12px`,
        tab.size === '12px' && tab.weight === '600' && select.size === '12px' && auxiliary.size === '11px' && checkbox.size === '12px' && width.size === '12px',
        JSON.stringify({ tab, select, auxiliary, checkbox, width }));
      await panel.getByRole('combobox', { name: '字体', exact: true }).click();
      const option = await font(page.getByRole('option', { name: '思源黑体', exact: true }));
      check(`${dark ? '深色' : '浅色'}下拉选项与触发器字号一致`, option.size === '12px', JSON.stringify(option));
      await page.keyboard.press('Escape');
      if (process.env.SCREENSHOT_DIR) {
        await panel.getByRole('combobox', { name: '形状', exact: true }).scrollIntoViewIfNeeded();
        await page.screenshot({ path: join(process.env.SCREENSHOT_DIR, `wmind-appearance-${dark ? 'dark' : 'light'}.png`) });
      }
    }
    await page.getByRole('tab', { name: '配色', exact: true }).click();
    const category = await font(page.getByRole('tab', { name: '缤纷', exact: true }));
    check('色板分类的 12px 字号与半粗选中态生效', category.size === '12px' && category.weight === '600', JSON.stringify(category));
    const name = await font(page.getByRole('textbox', { name: '主题名称', exact: true }));
    check('配色名称输入框保持 12px', name.size === '12px', JSON.stringify(name));
    check('没有浏览器异常', errors.length === 0, errors.join(' | '));
  } finally {
    await browser.close();
    if (uid) await api(`/maps/${uid}`, { method: 'DELETE', token });
  }
  return summary();
});
