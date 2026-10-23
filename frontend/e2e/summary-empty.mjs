import assert from 'node:assert/strict';
import os from 'node:os';
import { chromium } from 'playwright-core';

// 路由夹具承接真实编辑器的保存与刷新，不访问后端或真实用户数据库。
const base = process.env.BASE ?? 'http://127.0.0.1:5199';
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM ?? `${os.homedir()}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  const summary = { id: 'sum', topicId: 'root', range: ['a', 'b'], title: '清空前的概要', style: null };
  const detail = {
    uid: 'summary-empty', title: '概要空标题验收', thumbnailUrl: '/fixture-thumbnail.png', version: 1, nodeCount: 3,
    createdAt: '2026-10-24T00:00:00Z', updatedAt: '2026-10-24T00:00:00Z',
    document: { format: 'wmind', formatVersion: '1.0', title: '概要空标题验收', sheets: [{
      id: 'sheet', title: '画布', structure: 'logic-right', summaries: [summary],
      rootTopic: { id: 'root', title: '中心', summaries: [summary], children: { attached: [{ id: 'a', title: '甲' }, { id: 'b', title: '乙' }] } },
    }] },
  };
  let saves = 0;
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace('/api/v1', '');
    let data = [];
    if (path === '/auth/me') data = { uid: 'fixture-user', username: 'tester', nickname: '测试', email: '', role: 'user', status: 'active' };
    if (path === '/site/config') data = { siteName: 'wmind', shareEnabled: true };
    if (path === '/maps/summary-empty') {
      if (route.request().method() === 'PUT') {
        const saved = route.request().postDataJSON();
        detail.document = saved.document;
        detail.title = saved.title;
        detail.version += 1;
        detail.updatedAt = new Date().toISOString();
        saves += 1;
        data = { uid: detail.uid, version: detail.version, nodeCount: 3, updatedAt: detail.updatedAt };
      } else data = detail;
    }
    await route.fulfill({ json: { data } });
  });
  await page.goto(`${base}/maps/summary-empty`);
  const sum = page.locator('[data-summary-id="sum"]');
  const input = page.getByRole('textbox', { name: '概要文字', exact: true });
  const waitCanvas = () => sum.locator('rect').waitFor();
  const assertTitle = async (title) => {
    await page.waitForFunction((expected) => document.querySelector('[data-summary-id="sum"]').textContent === expected, title);
  };
  const check = (name) => console.log(`[PASS] ${name}`);
  await waitCanvas();
  await sum.locator('text').dblclick();
  await input.fill(''); await input.press('Enter'); await assertTitle('');
  assert.equal(await sum.getAttribute('aria-label'), '概要');
  check('画布清空后 Enter 提交，保留空概要与可访问名称');
  await page.getByRole('button', { name: '撤销', exact: true }).click(); await assertTitle(summary.title);
  await page.getByRole('button', { name: '重做', exact: true }).click(); await assertTitle('');
  check('撤销恢复旧文字，重做恢复空文字');
  await sum.locator('rect').dblclick(); assert.equal(await input.inputValue(), '');
  await input.fill('Esc 不提交'); await input.press('Escape'); await assertTitle('');
  check('空概要矩形能双击再编辑，Esc 保留空文字');
  await sum.locator('rect').click(); await page.keyboard.press('F2');
  await input.fill('失焦前'); await input.press('Enter'); await assertTitle('失焦前');
  await sum.locator('text').dblclick(); await input.fill('   ');
  await page.locator('g.wmind-topic[data-topic-id="a"]').click(); await assertTitle('');
  check('F2 可重新编辑，纯空白失焦保存为空');
  await page.keyboard.press('ControlOrMeta+s');
  await page.waitForFunction(() => document.body.innerText.includes('已保存'));
  assert.ok(saves > 0);
  assert.equal(detail.document.sheets[0].summaries[0].title, '');
  assert.equal(detail.document.sheets[0].rootTopic.summaries[0].title, '');
  await page.reload(); await waitCanvas(); await assertTitle('');
  check('保存同时清空两处概要数据，刷新保持空文字');
  await page.getByRole('tab', { name: '结构', exact: true }).click();
  const panelInput = page.locator('[data-annotation-title]').first();
  await panelInput.fill('侧栏文字'); await assertTitle('侧栏文字');
  await panelInput.fill(''); await panelInput.blur(); await assertTitle('');
  assert.equal(await panelInput.inputValue(), '');
  check('结构侧栏清空后不回弹旧文字');
  await page.keyboard.press('ControlOrMeta+s');
  await page.waitForFunction(() => document.body.innerText.includes('已保存'));
  await page.reload(); await waitCanvas(); await assertTitle('');
  check('侧栏清空保存刷新保持空文字');
  assert.deepEqual(errors, []);
  check('没有浏览器异常');
  console.log('\n概要空标题 8/8 通过');
} finally {
  await browser.close();
}
