import assert from 'node:assert/strict';
import { BASE, api, check, ensureUser, launchBrowser, makeUser, newPage, run, summary, uiLogin, waitForCanvas } from './lib/harness.mjs';

run(async () => {
  const user = makeUser('routing');
  const token = await ensureUser(user);
  const created = await api('/maps', { method: 'POST', token, body: { title: '走向验收', document: {
    format: 'wmind', formatVersion: '1.0', id: 'routing-doc', title: '走向验收', sheets: [{ id: 'sh', title: '画布', structure: 'mindmap',
      rootTopic: { id: 'root', title: '中心', children: { attached: [{ id: 'a', title: '甲' }, { id: 'b', title: '乙' }] } },
      relationships: [{ id: 'r', end1Id: 'a', end2Id: 'b', title: '依赖', style: { lineStyle: 'curve' } }],
    }],
  } } });
  const uid = created.data.uid;
  const browser = await launchBrowser();
  try {
    const { page, errors } = await newPage(browser);
    await uiLogin(page, user);
    await page.goto(`${BASE}/maps/${uid}`);
    await waitForCanvas(page);
    const path = page.locator('[data-relationship-path]');
    await page.locator('[data-relationship-id] text').click();
    const controls = page.locator('[data-relationship-control]');
    assert.equal(await controls.count(), 2);
    check('选择联系后显示双控制柄', true);
    const original = await path.getAttribute('d');
    const handle = await controls.first().boundingBox();
    const drag = async (x, y, dx, dy, cancel = false) => {
      await page.mouse.move(x, y); await page.mouse.down();
      await page.mouse.move(x + dx, y + dy, { steps: 8 });
      if (cancel) await page.keyboard.press('Escape');
      await page.mouse.up();
    };
    await drag(handle.x + handle.width / 2, handle.y + handle.height / 2, 30, -65, true);
    assert.equal(await path.getAttribute('d'), original);
    check('Esc 取消拖动并恢复原路径', true);
    const box = await controls.first().boundingBox();
    await drag(box.x + box.width / 2, box.y + box.height / 2, 45, -75);
    const adjusted = await path.getAttribute('d');
    assert.notEqual(adjusted, original);
    assert.match(adjusted, / C /);
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    assert.equal(await path.getAttribute('d'), original);
    await page.getByRole('button', { name: '重做', exact: true }).click();
    assert.equal(await path.getAttribute('d'), adjusted);
    check('拖动实时改路，一次撤销和重做覆盖整次拖动', true);
    await controls.nth(1).focus(); await page.keyboard.press('ArrowDown');
    assert.notEqual(await path.getAttribute('d'), adjusted);
    check('控制柄支持键盘微调', true);
    await page.waitForTimeout(1600);
    assert.ok((await api(`/maps/${uid}`, { token })).data.document.sheets[0].relationships[0].routing);
    const saved = await path.getAttribute('d');
    await page.reload(); await waitForCanvas(page);
    assert.equal(await path.getAttribute('d'), saved);
    check('走向保存后刷新保留', true);
    await page.locator('[data-relationship-id] text').click();
    await page.getByRole('button', { name: '恢复自动走向', exact: true }).click();
    assert.equal(await path.getAttribute('d'), original);
    check('恢复自动走向', true);
    await page.getByRole('combobox', { name: '线条样式', exact: true }).click();
    await page.getByRole('option', { name: '折线', exact: true }).click();
    assert.equal(await controls.count(), 1);
    const elbowOriginal = await path.getAttribute('d');
    const bend = await controls.first().boundingBox();
    await drag(bend.x + bend.width / 2, bend.y + bend.height / 2, 55, -65);
    assert.notEqual(await path.getAttribute('d'), elbowOriginal);
    check('折线控制点改变转折位置', true);
    await page.getByRole('button', { name: '只读预览', exact: true }).click();
    assert.equal(await controls.count(), 0);
    check('只读预览没有控制柄', true);
    if (process.env.SCREENSHOT_PATH) {
      await page.getByRole('button', { name: '退出预览', exact: true }).click();
      await page.screenshot({ path: process.env.SCREENSHOT_PATH });
    }
    check('没有浏览器异常', errors.length === 0, errors.join('\n'));
    return summary();
  } finally { await browser.close(); }
});
