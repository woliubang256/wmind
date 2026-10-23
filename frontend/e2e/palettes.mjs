import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BASE, api, check, ensureUser, launchBrowser, makeUser, newPage, run, summary, uiLogin, waitForCanvas } from './lib/harness.mjs';

const palettes = JSON.parse(readFileSync(new URL('../src/editor/theme/palettes.json', import.meta.url), 'utf8')).filter(p => !p.legacy);
const oldColors = ['#EB8589', '#E9B07E', '#DCCD8C', '#96BFA7', '#8BB9CE', '#B5A0CB'];

async function waitSaved(uid, token, paletteId) {
  for (let i = 0; i < 30; i += 1) {
    const doc = (await api(`/maps/${uid}`, { token })).data.document;
    if (doc.theme.id === paletteId) return doc;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`等待保存配色 ${paletteId} 超时`);
}

run(async () => {
  const user = makeUser('palettes');
  const token = await ensureUser(user);
  const browser = await launchBrowser();
  const maps = [];
  let customUid;
  try {
    const { page, errors } = await newPage(browser);
    await uiLogin(page, user);
    await page.goto(`${BASE}/`);
    await page.getByRole('button', { name: '新建导图', exact: true }).first().click();
    await page.locator('dialog[open]').getByRole('button', { name: /思维导图/ }).first().click();
    await page.waitForURL(url => url.pathname.startsWith('/maps/'));
    maps.push(page.url().split('/maps/')[1].split(/[?#]/)[0]);
    await waitForCanvas(page);
    assert.equal(await page.locator('g.wmind-topic[aria-level="1"] > rect').first().getAttribute('fill'), '#FFFFFF');
    assert.equal((await api(`/maps/${maps[0]}`, { token })).data.document.theme.id, 'vivid-dawn');
    check('真实新建流程使用黎明与白底中心主题', true);

    const fixture = await page.evaluate(async () => {
      const { createDocument, createTopic } = await import('/src/editor/model/create.ts');
      const doc = createDocument({ title: '参考色板验收', rootTitle: '产品规划' });
      doc.sheets[0].rootTopic.id = 'root';
      doc.sheets[0].rootTopic.children.attached = ['用户研究', '产品设计', '技术实现', '市场推广', '项目管理', '复盘迭代', '持续改进'].map((title, index) => ({
        ...createTopic({ id: `branch${index}`, title }),
        style: index === 0 ? { fill: '#456A86', lineColor: '#4F6D54' } : {},
        children: { attached: [createTopic({ id: `child${index}`, title: `要点 ${index + 1}` })], detached: [] },
      }));
      return doc;
    });
    const legacy = structuredClone(fixture);
    legacy.id += '-legacy';
    legacy.title = '保存的旧配色';
    legacy.theme = { ...legacy.theme, id: 'classic-rainbow', name: '彩虹', category: 'classic',
      palette: { ...legacy.theme.palette, colors: oldColors, lineColors: [...oldColors] }, rainbowColors: [...oldColors],
      centralTopic: { ...legacy.theme.centralTopic, fill: '#7EA9C0', borderColor: '#7EA9C0' },
    };
    for (const document of [fixture, legacy]) {
      const created = await api('/maps', { method: 'POST', token, body: { title: document.title, document } });
      maps.push(created.data.uid);
    }
    const topic = id => page.locator(`g.wmind-topic[data-topic-id="${id}"]`);
    const fill = id => topic(id).locator(':scope > rect').first().getAttribute('fill');
    const fingerprint = () => page.evaluate(() => JSON.stringify({
      topics: Array.from(document.querySelectorAll('g.wmind-topic > rect')).map(n => n.getAttribute('fill')),
      edges: Array.from(document.querySelectorAll('.layer-edges path')).map(n => n.getAttribute('stroke')),
    }));
    const texts = () => page.locator('g.wmind-topic > text').allTextContents();
    const cards = () => page.locator('[data-palette-id]:visible');
    const undo = page.getByRole('button', { name: '撤销', exact: true });
    const redo = page.getByRole('button', { name: '重做', exact: true });
    await page.goto(`${BASE}/maps/${maps[1]}`);
    await waitForCanvas(page);
    await page.getByRole('tab', { name: '配色', exact: true }).click();
    const colorful = page.getByRole('tab', { name: '缤纷', exact: true });
    const classic = page.getByRole('tab', { name: '经典', exact: true });
    const before = await fingerprint();
    const beforeTexts = await texts();
    for (const [category, tab, count] of [['vivid', colorful, 10], ['classic', classic, 9]]) {
      await tab.click();
      assert.equal(await cards().count(), count);
      assert.deepEqual(await cards().evaluateAll(nodes => nodes.map(n => n.getAttribute('aria-label'))), palettes.filter(p => p.category === category).map(p => p.name));
      check(`${category} 分类的数量、名称和顺序与参考目录一致`, true);
    }
    assert.equal(await fingerprint(), before);
    assert.equal(await undo.getAttribute('aria-disabled'), 'true');
    check('浏览分类不改画布，不产生撤销记录', true);
    await classic.focus();
    await classic.press('Home');
    assert.equal(await colorful.getAttribute('aria-selected'), 'true');
    await colorful.press('End');
    assert.equal(await classic.getAttribute('aria-selected'), 'true');
    await classic.press('ArrowRight');
    assert.equal(await colorful.evaluate(n => n === document.activeElement), true);
    await colorful.press('ArrowLeft');
    assert.equal(await classic.getAttribute('aria-selected'), 'true');
    assert.equal(await page.getByRole('tab', { name: '配色', exact: true }).getAttribute('aria-selected'), 'true');
    check('分类支持方向键及 Home/End，焦点与外层面板保持正确', true);

    const fingerprints = new Set();
    for (const palette of palettes) {
      await (palette.category === 'vivid' ? colorful : classic).click();
      await page.locator(`[data-palette-id="${palette.id}"]`).click();
      await page.waitForFunction(color => document.querySelector('g[data-topic-id="branch1"] > rect')?.getAttribute('fill') === color, palette.colors[1]);
      for (let i = 1; i < 7; i += 1) assert.equal(await fill(`branch${i}`), palette.colors[i % palette.colors.length]);
      assert.equal(await fill('branch0'), '#456A86');
      assert.ok(await page.locator('.layer-edges path').evaluateAll(nodes => nodes.every(n => n.getAttribute('stroke') !== '#FFFFFF')));
      assert.deepEqual(await texts(), beforeTexts);
      assert.equal(await page.locator(`[data-palette-id="${palette.id}"]`).getAttribute('aria-pressed'), 'true');
      fingerprints.add(await fingerprint());
      check(`${palette.name}：应用填充、保留内容及节点自定义颜色`, true);
    }
    assert.equal(fingerprints.size, 19);
    check('19 套画布配色指纹互不相同', true);
    const saved = await waitSaved(maps[1], token, 'classic-groove');
    assert.equal(saved.theme.palette.colors.length, 7);
    await page.reload();
    await waitForCanvas(page);
    await page.getByRole('tab', { name: '配色', exact: true }).click();
    assert.equal(await classic.getAttribute('aria-selected'), 'true');
    assert.equal(await fill('branch6'), palettes.find(p => p.id === 'classic-groove').colors[6]);
    check('七色配色保存刷新后完整保留并定位正确分类', true);
    await page.getByRole('textbox', { name: '主题名称', exact: true }).fill('七色律动');
    const createdTheme = page.waitForResponse(res => res.url().endsWith('/api/v1/themes') && res.request().method() === 'POST');
    await page.getByRole('button', { name: '保存当前', exact: true }).click();
    customUid = (await (await createdTheme).json()).data.uid;
    const customCard = page.getByRole('button', { name: '七色律动', exact: true });
    await customCard.waitFor();
    assert.equal(await customCard.locator('[data-palette-swatch] > span').count(), 7);
    check('自定义主题缩略图完整显示七色', true);

    await colorful.click();
    await page.locator('[data-palette-id="vivid-dawn"]').click();
    await classic.click();
    await page.locator('[data-palette-id="classic-zen"]').click();
    await undo.click();
    assert.equal(await colorful.getAttribute('aria-selected'), 'true');
    assert.equal(await fill('branch1'), '#FFA06B');
    await redo.click();
    assert.equal(await classic.getAttribute('aria-selected'), 'true');
    assert.equal(await fill('branch1'), '#EEEEEE');
    check('应用配色可撤销重做，分类跟随实际主题', true);
    await customCard.click();
    assert.equal(await fill('branch6'), palettes.find(p => p.id === 'classic-groove').colors[6]);
    check('已保存自定义主题可完整套用', true);

    await colorful.click();
    await page.locator('[data-palette-id="vivid-dawn"]').click();
    await page.getByRole('combobox', { name: '界面语言', exact: true }).click();
    await page.getByRole('option', { name: 'English', exact: true }).click();
    await page.getByRole('tab', { name: 'Colorful', exact: true }).click();
    assert.deepEqual(await cards().evaluateAll(nodes => nodes.map(n => n.getAttribute('aria-label'))), palettes.filter(p => p.category === 'vivid').map(p => p.nameEn));
    await page.getByRole('tab', { name: 'Classic', exact: true }).click();
    assert.equal(await cards().count(), 9);
    check('语言切换后分类和 19 套名称显示英文', true);
    await waitSaved(maps[1], token, 'vivid-dawn');
    await page.evaluate(() => localStorage.setItem('wmind:theme', 'dark'));
    await page.reload(); await waitForCanvas(page);
    await page.getByRole('tab', { name: 'Palette', exact: true }).click();
    assert.equal(await page.locator('html').evaluate(node => node.classList.contains('dark')), true);
    await page.getByRole('tab', { name: 'Classic', exact: true }).click();
    assert.equal(await cards().count(), 9);
    if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/wmind-palettes-dark.png` });
    check('深色界面中分类及色条可用', true);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await cards().evaluateAll(nodes => nodes.every(n => {
      const r = n.getBoundingClientRect(); return r.left >= 0 && r.right <= window.innerWidth;
    })));
    check('窄屏内两列色板均在视口内', true);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(() => { localStorage.setItem('wmind:theme', 'light'); localStorage.setItem('wmind:locale', 'zh-CN'); });
    await page.goto(`${BASE}/maps/${maps[2]}`);
    await page.reload(); await waitForCanvas(page);
    assert.equal(await fill('root'), '#7EA9C0');
    assert.equal(await fill('branch1'), '#E9B07E');
    assert.equal(await fill('branch0'), '#456A86');
    assert.deepEqual((await api(`/maps/${maps[2]}`, { token })).data.document.theme, legacy.theme);
    check('旧图读取保留完整旧主题和节点颜色', true);
    await page.getByRole('tab', { name: '配色', exact: true }).click();
    await colorful.click();
    await page.locator('[data-palette-id="vivid-dawn"]').click();
    assert.equal(await fill('root'), '#FFFFFF');
    assert.equal(await fill('branch1'), '#FFA06B');
    assert.equal(await fill('branch0'), '#456A86');
    await waitSaved(maps[2], token, 'vivid-dawn');
    check('旧图主动重选后使用新色，显式节点颜色不变', true);
    if (process.env.SCREENSHOT_DIR) {
      await page.goto(`${BASE}/maps/${maps[0]}`); await waitForCanvas(page);
      await page.getByRole('tab', { name: '配色', exact: true }).click();
      await colorful.click();
      await page.waitForTimeout(200); // 等分类选中态的颜色过渡结束再截图。
      await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/wmind-palettes-colorful.png` });
      await classic.click();
      await page.waitForTimeout(200);
      await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/wmind-palettes-classic.png` });
    }
    check('没有浏览器异常', errors.length === 0, errors.join('\n'));
    return summary();
  } finally {
    await browser.close();
    for (const uid of maps) await api(`/maps/${uid}`, { method: 'DELETE', token });
    if (customUid) await api(`/themes/${customUid}`, { method: 'DELETE', token });
  }
});
