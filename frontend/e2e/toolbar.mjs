import assert from 'node:assert/strict';
import { BASE, check, ensureUser, launchBrowser, makeUser, newPage, run, summary, uiLogin, waitForCanvas } from './lib/harness.mjs';

run(async () => {
  const user = makeUser('toolbar');
  await ensureUser(user);
  const browser = await launchBrowser();
  try {
    const { page, errors } = await newPage(browser);
    await uiLogin(page, user);
    await page.goto(`${BASE}/maps/demo`);
    await waitForCanvas(page);
    const toolbar = page.locator('[data-editor-toolbar]');
    assert.equal(await toolbar.locator('button').evaluateAll((buttons) => buttons.every((button) => !button.textContent.trim() && !!button.getAttribute('aria-label'))), true);
    for (const name of ['编辑', '界面', '操作']) await toolbar.getByRole('group', { name, exact: true }).waitFor();
    check('工具栏按编辑、界面、操作分组，所有入口仅显示图标并保留可访问名称', true);
    assert.equal(await toolbar.getByRole('combobox', { name: '结构', exact: true }).count(), 0);
    assert.equal(await toolbar.getByRole('button', { name: /隐藏面板|显示面板/ }).count(), 0);
    const structure = page.locator('#editor-canvas-panel').getByRole('combobox', { name: '结构', exact: true });
    const initialStructure = await structure.getAttribute('data-value');
    await structure.focus();
    await structure.press('ArrowDown');
    await page.getByRole('listbox').press('End');
    await page.getByRole('listbox').press('Enter');
    assert.notEqual(await structure.getAttribute('data-value'), initialStructure);
    assert.equal(await structure.evaluate((node) => node === document.activeElement), true);
    await toolbar.getByRole('button', { name: '撤销', exact: true }).click();
    assert.equal(await structure.getAttribute('data-value'), initialStructure);
    check('结构入口只在侧栏，支持键盘切换、返回焦点和撤销', true);
    const panel = page.getByRole('button', { name: '隐藏面板', exact: true });
    await panel.click();
    await page.getByRole('button', { name: '显示面板', exact: true }).click();
    check('右上角唯一入口可以隐藏并恢复面板', true);
    for (const width of [375, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      const geometry = await toolbar.evaluate((element) => {
        const buttons = [...element.querySelectorAll('button')].map((button) => button.getBoundingClientRect());
        return {
          singleRow: buttons.every((rect) => Math.abs(rect.top - buttons[0].top) < 1 && rect.width >= 40),
          overflow: element.scrollWidth > element.clientWidth,
          pageFits: document.documentElement.scrollWidth <= window.innerWidth,
        };
      });
      assert.equal(geometry.singleRow, true);
      assert.equal(geometry.pageFits, true);
      if (width === 375) assert.equal(geometry.overflow, true);
      for (const button of await toolbar.locator('button').all()) {
        await button.scrollIntoViewIfNeeded();
        assert.equal(await button.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          const clip = element.closest('[data-editor-toolbar]').getBoundingClientRect();
          return rect.left >= clip.left - 1 && rect.right <= clip.right + 1;
        }), true);
      }
      if (process.env.SCREENSHOT_PATH && width === 1440) await page.locator('header').last().screenshot({ path: process.env.SCREENSHOT_PATH });
    }
    check('桌面和窄屏工具栏保持单行，横向滚动可到达全部入口且页面不溢出', true);
    // 后面的提示用例依赖空历史；重新载入演示文档。
    await page.reload();
    await waitForCanvas(page);
    const undo = page.getByRole('button', { name: '撤销', exact: true });
    await undo.hover();
    await page.getByRole('tooltip').waitFor({ timeout: 2500 });
    assert.match(await page.getByRole('tooltip').textContent(), /没有可撤销/);
    check('不可用按钮悬停显示原因', true);
    await page.mouse.move(0, 0);
    await undo.focus();
    await page.getByRole('tooltip').waitFor();
    assert.equal(await undo.getAttribute('aria-describedby'), await page.getByRole('tooltip').getAttribute('id'));
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('tooltip').count(), 0);
    check('聚焦显示提示，Esc 关闭并关联描述', true);
    const root = page.locator('g.wmind-topic').filter({ hasText: /^产品规划$/ });
    await root.click();
    assert.equal(await page.getByRole('button', { name: '新建同级主题', exact: true }).getAttribute('aria-disabled'), 'true');
    await page.getByRole('button', { name: '插入', exact: true }).click();
    assert.equal(await page.getByRole('menuitem', { name: /新建同级主题/ }).count(), 0);
    assert.equal(await page.getByRole('menuitem').evaluateAll((items) => items.every((item) => item.querySelector('svg') && item.textContent.trim())), true);
    await page.keyboard.press('Escape');
    check('根主题禁用同级，Insert 不包含主题创建操作', true);
    await page.getByRole('button', { name: '插入', exact: true }).click();
    await page.getByRole('menuitem', { name: '链接', exact: true }).click();
    assert.equal(await page.getByRole('menuitem').evaluateAll((items) => items.every((item) => item.querySelector('svg') && item.textContent.trim())), true);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    check('Insert 及链接子菜单每项都有图标和文字', true);
    const branch = page.locator('g.wmind-topic').filter({ hasText: /^用户研究/ }).first();
    await branch.click();
    const level = await branch.getAttribute('aria-level');
    await page.getByRole('button', { name: '新建同级主题', exact: true }).click();
    const input = page.locator('textarea');
    await input.waitFor();
    assert.equal(await input.evaluate((node) => node === document.activeElement), true);
    await input.fill('新增同级');
    await input.press('Enter');
    const sibling = page.locator('g.wmind-topic').filter({ hasText: /^新增同级$/ });
    assert.equal(await sibling.getAttribute('aria-level'), level);
    check('独立按钮创建同级，层级正确并自动编辑', true);
    await page.getByRole('button', { name: '新建子主题', exact: true }).click();
    await input.waitFor();
    await input.fill('新增子级');
    await input.press('Enter');
    assert.equal(Number(await page.locator('g.wmind-topic').filter({ hasText: /^新增子级$/ }).getAttribute('aria-level')), Number(level) + 1);
    check('独立按钮创建子级，层级正确', true);
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    assert.equal(await page.locator('g.wmind-topic').filter({ hasText: /^新增子级$/ }).count(), 0);
    check('新建主题支持撤销', true);
    check('没有浏览器异常', errors.length === 0, errors.join('\n'));
    return summary();
  } finally { await browser.close(); }
});
