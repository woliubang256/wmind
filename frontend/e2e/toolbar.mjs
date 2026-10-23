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
    check('没有浏览器异常', errors.length === 0, errors.join('\n'));
    return summary();
  } finally { await browser.close(); }
});
