import assert from 'node:assert/strict';
import { BASE, api, check, ensureUser, launchBrowser, makeUser, newPage, run, summary, uiLogin, waitForCanvas } from './lib/harness.mjs';

run(async () => {
  const user = makeUser('dragreturn');
  const token = await ensureUser(user);
  const topic = (id, title, attached = []) => ({ id, title, children: { attached } });
  const title = '拖拽回归验收';
  const created = await api('/maps', { method: 'POST', token, body: { title, document: {
    format: 'wmind', formatVersion: '1.0', title,
    sheets: [{ id: 'sh', title: '画布', structure: 'logic-right', rootTopic: topic('root', title, [
      topic('a', '原父级', [topic('a1', '前一个主题'), topic('a2', '拖动主题', [topic('a2x', '跟随的子主题')]), topic('a3', '后一个主题')]),
      topic('b', '新父级'),
    ]) }],
  } } });
  const browser = await launchBrowser();
  try {
    const { page, errors } = await newPage(browser);
    await uiLogin(page, user);
    await page.goto(`${BASE}/maps/${created.data.uid}`);
    await waitForCanvas(page);
    const node = (id) => page.locator(`g.wmind-topic[data-topic-id="${id}"]`);
    const shape = (id) => node(id).locator(':scope > rect').first();
    const toolbar = page.locator('[data-editor-toolbar]');
    const undo = toolbar.getByRole('button', { name: '撤销', exact: true });
    const canvas = page.locator('svg[data-read-only="false"]');
    const feedback = (text) => page.locator('.wmind-drag-layer text').filter({ hasText: text });
    const edges = () => page.locator('[data-edge-id]').evaluateAll((items) => items.map((item) => item.getAttribute('data-edge-id')).sort());
    const snapshot = () => node('root').evaluate(() => ({
      nodes: [...document.querySelectorAll('g.wmind-topic')].map((item) => ({
        id: item.getAttribute('data-topic-id'), level: item.getAttribute('aria-level'),
        title: item.getAttribute('aria-label'), x: item.querySelector('rect')?.getAttribute('x'), y: item.querySelector('rect')?.getAttribute('y'),
      })),
      edges: [...document.querySelectorAll('[data-edge-id]')].map((item) => item.getAttribute('data-edge-id')).sort(),
    }));
    const box = (id = 'a2') => shape(id).boundingBox();
    const center = (rect) => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
    const move = (point) => page.mouse.move(point.x, point.y, { steps: 5 });
    const far = async () => { const rect = await canvas.boundingBox(); return { x: rect.x + 20, y: rect.y + 20 }; };
    const begin = async () => { await move(center(await box())); await page.mouse.down(); await move(await far()); await feedback('松开转为自由主题').waitFor(); };
    const releaseUnchanged = async (before) => {
      await page.mouse.up();
      await page.locator('.wmind-drag-layer').waitFor({ state: 'detached' });
      assert.deepEqual(await snapshot(), before);
      assert.equal(await undo.getAttribute('aria-disabled'), 'true');
    };
    await toolbar.getByRole('button', { name: '缩放到适应', exact: true }).click();
    const initial = await snapshot();

    await begin();
    await move(center(await box()));
    await feedback('松开保持原位置').waitFor();
    assert.equal(await feedback('松开转为自由主题').count(), 0);
    await releaseUnchanged(initial);
    check('拖远后返回原外框，取消脱离且父级、顺序、子树和撤销历史均不变', true);

    await begin();
    let source = await box();
    await move({ x: source.x + source.width + 20, y: source.y + source.height / 2 });
    await feedback('松开保持原位置').waitFor();
    if (process.env.SCREENSHOT_PATH) await page.screenshot({ path: process.env.SCREENSHOT_PATH });
    await releaseUnchanged(initial);
    check('原外框外 20 屏幕像素也能回归，松手不需要撤销', true);

    await begin();
    await move(center(await box()));
    await feedback('松开保持原位置').waitFor();
    await move(await far());
    await feedback('松开转为自由主题').waitFor();
    await move(center(await box()));
    await feedback('松开保持原位置').waitFor();
    await releaseUnchanged(initial);
    check('一次拖拽可反复离开与回归，预览实时更新', true);

    for (const [action, count] of [['缩小', 4], ['放大', 6]]) {
      for (let index = 0; index < count; index++) await toolbar.getByRole('button', { name: action, exact: true }).click();
      const before = await snapshot();
      await begin();
      source = await box();
      await move({ x: source.x + source.width + 20, y: source.y + source.height / 2 });
      await feedback('松开保持原位置').waitFor();
      await move({ x: source.x + source.width + 30, y: source.y + source.height / 2 });
      // 越过回归范围后可能命中附近目标（包括自己的后代），只断言不再回归。
      await feedback('松开保持原位置').waitFor({ state: 'detached' });
      await move({ x: source.x + source.width + 20, y: source.y + source.height / 2 });
      await feedback('松开保持原位置').waitFor();
      await releaseUnchanged(before);
    }
    check('缩小和放大后，回归范围保持相同屏幕距离', true);
    await toolbar.getByRole('button', { name: '缩放到适应', exact: true }).click();

    await node('a1').click();
    await node('a2').click({ modifiers: ['Shift'] });
    const multi = await snapshot();
    await begin();
    await move(center(await box()));
    await feedback('松开保持原位置').waitFor();
    await releaseUnchanged(multi);
    assert.equal(await node('a1').getAttribute('aria-selected'), 'true');
    assert.equal(await node('a2').getAttribute('aria-selected'), 'true');
    check('多选从第二个主题抓取并回归，整组结构和选区保持不变', true);

    // 在没有拖动的普通点击中收敛多选，再验证现有移动与脱离。
    await node('a2').click();
    const originalEdges = await edges();
    await begin();
    await move(center(await box('b')));
    await feedback('松开转为自由主题').waitFor({ state: 'detached' });
    await page.mouse.up();
    assert.equal(await page.locator('[data-edge-id="b->a2"]').count(), 1);
    assert.equal(await page.locator('[data-edge-id="a2->a2x"]').count(), 1);
    await undo.click();
    assert.deepEqual(await edges(), originalEdges);
    assert.equal(await undo.getAttribute('aria-disabled'), 'true');
    check('拖到其他主题仍可改变父级，子树保留并支持一步撤销', true);

    await begin();
    await move(center(await box('a2x')));
    await feedback('不能放到自己的子节点里').waitFor();
    await page.mouse.up();
    assert.deepEqual(await edges(), originalEdges);
    assert.equal(await undo.getAttribute('aria-disabled'), 'true');
    check('后代落点仍被拒绝，不产生变更', true);

    await begin();
    await page.mouse.up();
    assert.equal(await page.locator('[data-edge-id="a->a2"]').count(), 0);
    assert.equal(await page.locator('[data-edge-id="a2->a2x"]').count(), 1);
    assert.equal(await node('a2').count(), 1);
    await undo.click();
    assert.deepEqual(await edges(), originalEdges);
    assert.equal(await undo.getAttribute('aria-disabled'), 'true');
    check('远处松手仍会转为自由主题，整棵子树一步撤销恢复', true);

    await node('a2').dblclick();
    const input = page.locator('textarea');
    await input.fill('此前已改名');
    await input.press('Enter');
    const renamed = await snapshot();
    await begin();
    await move(center(await box()));
    await feedback('松开保持原位置').waitFor();
    await page.mouse.up();
    assert.deepEqual(await snapshot(), renamed);
    await undo.click();
    assert.equal(await node('a2').getAttribute('aria-label'), '拖动主题');
    assert.equal(await undo.getAttribute('aria-disabled'), 'true');
    check('回归不占用撤销步骤，撤销直接还原此前编辑', true);

    check('没有浏览器异常', errors.length === 0, errors.join('\n'));
    return summary();
  } finally { await browser.close(); }
});
