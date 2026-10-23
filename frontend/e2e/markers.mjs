import assert from 'node:assert/strict';
import { BASE, api, check, ensureUser, launchBrowser, makeUser, newPage, run, summary, uiLogin, waitForCanvas } from './lib/harness.mjs';

run(async () => {
  const user = makeUser('markers'); const token = await ensureUser(user);
  const created = await api('/maps', { method: 'POST', token, body: { title: '标记验收', document: {
    format: 'wmind', formatVersion: '1.0', title: '标记验收', sheets: [{ id: 'sh', title: '画布', structure: 'mindmap',
      rootTopic: { id: 'root', title: '标记验收', children: { attached: [
        { id: 'a', title: '固定宽度的长标题', style: { width: 100, autoWidth: false }, markers: [{ groupId: 'task', markerId: 'task-start' }] },
        { id: 'b', title: '另一个主题' },
      ] } },
    }],
  } } });
  const uid = created.data.uid; const browser = await launchBrowser();
  try {
    const { page, errors } = await newPage(browser);
    await uiLogin(page, user); await page.goto(`${BASE}/maps/${uid}`); await waitForCanvas(page);
    const a = page.locator('g.wmind-topic[data-topic-id="a"]');
    const b = page.locator('g.wmind-topic[data-topic-id="b"]');
    const icons = (topic) => topic.locator('[data-marker-id]');
    assert.equal(await a.locator('[data-marker-id="task-start"]').count(), 1);
    check('已有标记数据直接渲染', true);
    await a.click(); await page.getByRole('button', { name: '标记', exact: true }).click();
    const panel = page.getByRole('tabpanel', { name: '标记', exact: true });
    assert.equal(await panel.locator('[data-marker-id]').count(), 42);
    await panel.getByRole('button', { name: '优先级 1', exact: true }).click();
    await panel.getByRole('button', { name: '优先级 2', exact: true }).click();
    assert.equal(await a.locator('[data-marker-id="priority-1"]').count(), 0);
    assert.equal(await a.locator('[data-marker-id="priority-2"]').count(), 1);
    assert.equal(await icons(a).count(), 2);
    check('42 个图标可用，同组替换且异组共存', true);
    await b.click({ modifiers: ['Shift'] });
    const priority = panel.getByRole('button', { name: '优先级 2', exact: true });
    assert.equal(await priority.getAttribute('aria-pressed'), 'mixed');
    await priority.click();
    assert.equal(await b.locator('[data-marker-id="priority-2"]').count(), 1);
    await priority.click();
    assert.equal(await a.locator('[data-marker-id="priority-2"]').count(), 0);
    assert.equal(await b.locator('[data-marker-id="priority-2"]').count(), 0);
    check('混合多选统一应用，再次点击统一取消', true);
    await a.click();
    for (const label of ['优先级 1', '任务：已完成', '红色旗帜', '蓝色星标', '人物 3', '警告']) {
      await panel.getByRole('button', { name: label, exact: true }).click();
    }
    assert.equal(await icons(a).count(), 6);
    const rects = await icons(a).evaluateAll((nodes) => nodes.map((node) => {
      const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom };
    }));
    const text = await a.locator(':scope > text').boundingBox();
    assert.ok(rects.every((rect) => rect.bottom <= text.y + 1));
    check('窄主题内多标记换行并避开文字', true);
    await a.dblclick(); const input = page.locator('textarea'); await input.waitFor();
    const edit = await input.boundingBox();
    assert.ok(rects.every((rect) => rect.bottom <= edit.y + 2));
    await input.press('Escape');
    check('编辑框避开标记', true);
    await page.waitForTimeout(1600);
    const saved = (await api(`/maps/${uid}`, { token })).data.document.sheets[0].rootTopic.children.attached[0];
    assert.equal(saved.markers.length, 6);
    await page.reload(); await waitForCanvas(page);
    assert.equal(await icons(a).count(), 6);
    check('标记保存后刷新保留', true);
    await a.click(); await page.getByRole('button', { name: '标记', exact: true }).click();
    await panel.getByRole('button', { name: '清空标记', exact: true }).click();
    assert.equal(await icons(a).count(), 0);
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    assert.equal(await icons(a).count(), 6);
    await page.getByRole('button', { name: '重做', exact: true }).click();
    assert.equal(await icons(a).count(), 0);
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    check('清空标记可一次撤销重做', true);
    await page.getByRole('button', { name: '只读预览', exact: true }).click();
    assert.equal(await icons(a).count(), 6); assert.equal(await panel.count(), 0);
    check('预览保留图标并移除编辑面板', true);
    if (process.env.SCREENSHOT_PATH) {
      await page.getByRole('button', { name: '退出预览', exact: true }).click();
      await page.getByRole('button', { name: '标记', exact: true }).click();
      await page.screenshot({ path: process.env.SCREENSHOT_PATH });
    }
    check('没有浏览器异常', errors.length === 0, errors.join('\n'));
    return summary();
  } finally { await browser.close(); }
});
