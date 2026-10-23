import assert from 'node:assert/strict';
import { BASE, api, check, ensureUser, launchBrowser, makeUser, newPage, run, summary, uiLogin, waitForCanvas } from './lib/harness.mjs';

run(async () => {
  const user = makeUser('sumend'); const token = await ensureUser(user); const title = '概要端点验收';
  const created = await api('/maps', { method: 'POST', token, body: { title, document: { format: 'wmind', formatVersion: '1.0', title,
    sheets: [{ id: 'sh', title: '画布', structure: 'mindmap', rootTopic: { id: 'root', title, children: { attached: [{ id: 'a', title: '主题甲' }, { id: 'b', title: '主题乙' }] } },
      summaries: [{ id: 's1', topicId: 'root', range: ['a'], title: '概要甲', style: null }, { id: 's2', topicId: 'root', range: ['b'], title: '概要乙', style: null }] }] } } });
  const browser = await launchBrowser();
  try {
    const { page, errors } = await newPage(browser); await uiLogin(page, user); await page.goto(`${BASE}/maps/${created.data.uid}`); await waitForCanvas(page);
    const sum = (id) => page.locator(`[data-summary-id="${id}"]`);
    const node = (id) => page.locator(`g.wmind-topic[data-topic-id="${id}"]`);
    const clickSum = (id, extra = {}) => sum(id).locator('text').first().click(extra);
    const relationship = () => page.locator('[data-relationship-id]');
    await clickSum('s1'); assert.equal(await sum('s1').getAttribute('aria-selected'), 'true');
    await page.getByRole('button', { name: '插入', exact: true }).click(); assert.equal(await page.getByRole('menuitem', { name: '标签', exact: true }).getAttribute('aria-disabled'), 'true'); await page.keyboard.press('Escape'); check('概要直接选中，主题 Insert 不误作用到根', true);
    await node('b').click({ modifiers: ['Shift'] }); await page.getByRole('button', { name: '联系', exact: true }).first().click(); assert.equal(await relationship().count(), 1); check('概要到主题建立联系', true);
    const path = relationship().first().locator('[data-relationship-path]'); const old = await path.getAttribute('d');
    await page.locator('[data-relationship-control="0"]').focus(); await page.keyboard.press('ArrowUp'); assert.notEqual(await path.getAttribute('d'), old); check('概要端点联系可调整控制柄', true);
    await clickSum('s1'); await clickSum('s2', { modifiers: ['Shift'] }); assert.equal(await sum('s2').getAttribute('aria-selected'), 'true'); await page.getByRole('button', { name: '联系', exact: true }).first().click(); assert.equal(await relationship().count(), 2); check('概要到概要建立联系', true);
    await clickSum('s1'); await page.getByRole('button', { name: '删除所选', exact: true }).click(); assert.equal(await sum('s1').count(), 0); assert.equal(await relationship().count(), 0); await page.getByRole('button', { name: '撤销', exact: true }).click(); assert.equal(await sum('s1').count(), 1); assert.equal(await relationship().count(), 2); check('删除概要清理联系，一次撤销完整恢复', true);
    await node('a').click(); await page.getByRole('button', { name: '删除所选', exact: true }).click(); assert.equal(await sum('s1').count(), 0); assert.equal(await relationship().count(), 0); await page.getByRole('button', { name: '撤销', exact: true }).click(); assert.equal(await relationship().count(), 2); check('删除概要范围主题也清理联系并可撤销', true);
    await sum('s1').locator('text').first().dblclick(); const input = page.getByRole('textbox', { name: '概要文字', exact: true }); await input.fill('改名概要'); await input.press('Enter'); assert.match(await sum('s1').textContent(), /改名概要/); check('概要双击编辑标题', true);
    await page.keyboard.press('ControlOrMeta+s'); await page.waitForFunction(() => document.body.innerText.includes('已保存')); await page.reload(); await waitForCanvas(page); assert.equal(await relationship().count(), 2); assert.match(await sum('s1').textContent(), /改名概要/); check('刷新保留概要标题和两类联系', true);
    check('没有浏览器异常', errors.length === 0, errors.join('\n')); return summary();
  } finally { await browser.close(); }
});
