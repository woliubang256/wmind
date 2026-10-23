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
  const maps = [];
  try {
    const { page, errors } = await newPage(browser);
    await page.goto(`${BASE}/login`);
    const login = await font(page.getByRole('button', { name: '登录', exact: true }));
    check('普通表单按钮保留 14px 和中等字重', login.size === '14px' && login.weight === '500', JSON.stringify(login));
    await uiLogin(page, user);
    await page.getByRole('button', { name: '新建导图', exact: true }).first().click();
    await page.locator('dialog[open]').getByRole('button', { name: /思维导图/ }).first().click();
    await page.waitForURL((url) => url.pathname.startsWith('/maps/'));
    maps.push(page.url().split('/maps/')[1].split(/[?#]/)[0]);
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

    const fixture = await page.evaluate(async () => {
      const { createDocument, createTopic, createSheet } = await import('/src/editor/model/create.ts');
      const doc = createDocument({ title: '统一形状验收' });
      const root = doc.sheets[0].rootTopic;
      root.id = 'root';
      root.style = { shape: 'diamond' };
      const branch = createTopic({ id: 'a', title: '选中分支' });
      branch.style = { shape: 'ellipse', fill: '#456A86', fontSize: 18 };
      branch.children.attached.push(createTopic({ id: 'a1', title: '后代主题' }));
      const collapsed = createTopic({ id: 'b', title: '折叠分支' });
      collapsed.collapsed = true;
      collapsed.children.attached.push(createTopic({ id: 'b1', title: '隐藏后代' }));
      root.children.attached.push(branch, collapsed);
      doc.sheets[0].floatingTopics.push(createTopic({ id: 'f', title: '自由主题' }));
      doc.sheets.push(createSheet({ title: '第二画布' }));
      return doc;
    });
    const created = await api('/maps', { method: 'POST', token, body: { title: fixture.title, document: fixture } });
    maps.push(created.data.uid);
    await page.goto(`${BASE}/maps/${created.data.uid}`);
    await waitForCanvas(page);
    await page.locator('g[data-topic-id="a"]').click();
    await page.getByRole('combobox', { name: '形状', exact: true }).click();
    await page.getByRole('option', { name: '圆角矩形', exact: true }).click();
    const nodes = await page.locator('g.wmind-topic').evaluateAll((nodes) => nodes.map((node) => ({
      id: node.getAttribute('data-topic-id'),
      rounded: node.firstElementChild?.tagName === 'rect' && node.firstElementChild.hasAttribute('rx'),
    })));
    check('单选后更换形状作用于全画布主题', nodes.length === 5 && nodes.every((node) => node.rounded), JSON.stringify(nodes));
    const branch = page.locator('g[data-topic-id="a"]');
    const paint = await branch.evaluate((node) => ({
      fill: node.firstElementChild.getAttribute('fill'),
      fontSize: getComputedStyle(node.querySelector('text')).fontSize,
    }));
    check('全局形状保留节点颜色与字号', paint.fill === '#456A86' && paint.fontSize === '18px', JSON.stringify(paint));
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    check('一次撤销恢复原有混合形状', await page.locator('g[data-topic-id="root"] > polygon').count() === 1 && await branch.locator(':scope > ellipse').count() === 1);
    await page.getByRole('button', { name: '重做', exact: true }).click();
    check('一次重做恢复全局形状', await page.getByRole('combobox', { name: '形状', exact: true }).getAttribute('data-value') === 'rounded-rect');
    await branch.click();
    await page.keyboard.press('Tab');
    await page.locator('textarea').fill('新增主题');
    await page.locator('textarea').press('Enter');
    const newTopic = page.locator('g.wmind-topic').filter({ hasText: '新增主题' });
    check('新建主题继承全局形状', await newTopic.locator(':scope > rect[rx]').first().count() === 1);
    await page.locator('[data-collapse-toggle="b"]').click();
    check('展开折叠主题后，隐藏后代也使用统一形状', await page.locator('g[data-topic-id="b1"] > rect[rx]').count() === 1);
    await page.locator('[data-sheet-tab]').nth(1).click();
    check('其他画布不受形状修改影响', await page.getByRole('combobox', { name: '形状', exact: true }).getAttribute('data-value') === 'inherit');
    await page.locator('[data-sheet-tab]').first().click();
    for (let i = 0; i < 50; i += 1) {
      const saved = (await api(`/maps/${created.data.uid}`, { token })).data.document;
      if (saved.sheets[0].topicShape === 'rounded-rect' && saved.sheets[0].rootTopic.children.attached[0].children.attached.length === 2 && !saved.sheets[0].rootTopic.children.attached[1].collapsed) break;
      if (i === 49) throw new Error('统一形状及新增主题保存超时');
      await page.waitForTimeout(200);
    }
    await page.reload();
    await waitForCanvas(page);
    check('保存刷新保留全局形状与新增主题', await page.getByRole('combobox', { name: '形状', exact: true }).getAttribute('data-value') === 'rounded-rect' && await page.locator('g.wmind-topic').count() === 7);
    await page.getByRole('button', { name: '只读预览', exact: true }).click();
    check('只读预览复用全画布形状', await page.locator('.layer-topics > g > ellipse, .layer-topics > g > polygon').count() === 0 && await page.locator('.layer-topics > g > rect[rx]').count() >= 7);
    await page.getByRole('button', { name: '退出预览', exact: true }).click();
    check('没有浏览器异常', errors.length === 0, errors.join(' | '));
  } finally {
    await browser.close();
    for (const uid of maps) await api(`/maps/${uid}`, { method: 'DELETE', token });
  }
  return summary();
});
