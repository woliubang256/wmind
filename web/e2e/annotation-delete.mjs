import assert from 'node:assert/strict';
import { BASE, api, check, ensureUser, launchBrowser, makeUser, newPage, run, summary, uiLogin, waitForCanvas } from './lib/harness.mjs';

run(async () => {
  const user = makeUser('annDelete');
  const token = await ensureUser(user);
  const created = await api('/maps', { method: 'POST', token, body: { title: '删除验收', document: {
    format: 'wmind', formatVersion: '1.0', id: 'delete-doc', title: '删除验收', sheets: [{ id: 'sh', title: '画布', structure: 'mindmap',
      rootTopic: { id: 'root', title: '中心', children: { attached: [{ id: 'a', title: '甲' }, { id: 'b', title: '乙' }] } },
      relationships: [{ id: 'r', end1Id: 'a', end2Id: 'b', title: '依赖' }],
      boundaries: [{ id: 'bd', range: ['a', 'b'], title: '范围' }],
    }, { id: 'sh2', title: '画布二', structure: 'mindmap',
      rootTopic: { id: 'root2', title: '另一个中心', children: { attached: [{ id: 'a2', title: '丙' }, { id: 'b2', title: '丁' }] } },
      relationships: [{ id: 'r', end1Id: 'a2', end2Id: 'b2', title: '另一个联系' }],
    }],
  } } });
  const browser = await launchBrowser();
  try {
    const { page, errors } = await newPage(browser);
    await uiLogin(page, user); await page.goto(`${BASE}/maps/${created.data.uid}`); await waitForCanvas(page);
    const relation = page.locator('[data-relationship-id="r"]');
    const boundary = page.locator('[data-boundary-id="bd"]');
    const topics = page.locator('g.wmind-topic');
    const undo = async () => { await page.getByRole('button', { name: '撤销', exact: true }).click(); };
    await relation.locator('text').click(); await page.keyboard.press('Delete');
    assert.equal(await relation.count(), 0, 'Delete 必须删除选中的联系');
    assert.equal(await topics.count(), 3); await undo(); assert.equal(await relation.count(), 1);
    check('联系 Delete 删除且撤销恢复，不误删主题', true);
    await relation.locator('text').click(); await page.locator('[data-relationship-control]').first().focus();
    await page.keyboard.press('Backspace'); assert.equal(await relation.count(), 0); await undo();
    check('控制柄聚焦后 Backspace 删除联系', true);
    await relation.locator('text').dblclick();
    // 文本编辑必须保留普通删除键。
    const title = page.getByRole('textbox', { name: '联系文字', exact: true });
    await title.fill('文本'); await title.press('Backspace'); assert.equal(await relation.count(), 1);
    await title.press('Escape');
    await relation.locator('text').click(); await page.getByRole('button', { name: '删除所选', exact: true }).click();
    assert.equal(await relation.count(), 0); await undo();
    check('联系标题编辑安全，工具栏删除共用选中对象', true);
    await relation.locator('text').click(); await page.keyboard.press('ArrowRight');
    assert.ok(await page.locator('g.wmind-topic[aria-selected="true"]').count());
    await page.keyboard.press('Delete'); assert.equal(await topics.count(), 2, '导航到主题后必须删除当前主题');
    await undo(); assert.equal(await topics.count(), 3); assert.equal(await relation.count(), 1);
    check('联系切换到键盘主题选区后删除当前对象', true);
    {
      await boundary.locator('text').click(); assert.equal(await boundary.getAttribute('aria-pressed'), 'true');
      await page.keyboard.press('Delete'); assert.equal(await boundary.count(), 0); assert.equal(await topics.count(), 3); await undo();
      check('边界标题可选中、删除、撤销，内部主题保留', true);
      const hit = boundary.locator('[data-boundary-hit]'); const box = await hit.boundingBox();
      await page.mouse.click(box.x + box.width - 1, box.y + box.height / 2);
      assert.equal(await boundary.getAttribute('aria-pressed'), 'true');
      await page.getByRole('button', { name: '删除所选', exact: true }).click();
      assert.equal(await boundary.count(), 0); await undo();
      await page.getByRole('button', { name: '重做', exact: true }).click(); assert.equal(await boundary.count(), 0); await undo();
      check('边界边框可选中，工具栏删除及重做正常', true);
      await boundary.focus(); await page.keyboard.press('Space'); await page.keyboard.press('Backspace');
      assert.equal(await boundary.count(), 0); await undo();
      check('边界支持键盘选中与删除', true);
      await boundary.locator('text').click(); await page.keyboard.press('Escape'); await page.keyboard.press('Delete');
      assert.equal(await boundary.count(), 1);
      await page.locator('[data-topic-id="a"]').click(); await page.keyboard.press('Escape');
      assert.equal(await boundary.getAttribute('aria-pressed'), 'false');
      check('取消边界选中后 Delete 无副作用，内部主题仍能选中', true);
      await relation.locator('text').click();
      await page.getByRole('tab', { name: '画布二', exact: true }).click();
      assert.equal(await relation.getAttribute('aria-pressed'), 'false');
      await page.getByRole('tree').focus(); await page.keyboard.press('Delete');
      assert.equal(await relation.count(), 1); assert.equal(await topics.count(), 3);
      await page.getByRole('tab', { name: '画布', exact: true }).click();
      check('切换画布清空旧激活态，不误删同 id 联系', true);
      await page.getByRole('button', { name: '只读预览', exact: true }).click();
      assert.equal(await boundary.getAttribute('role'), null);
      check('只读预览没有边界编辑入口', true);
    }
    check('没有浏览器异常', errors.length === 0, errors.join('\n'));
    return summary();
  } finally { await browser.close(); }
});
