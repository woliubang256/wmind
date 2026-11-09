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

    const fanFixture = await page.evaluate(async () => {
      const { createDocument, createTopic } = await import('/src/editor/model/create.ts');
      const doc = createDocument({ title: '分散连线验收', rootTitle: 'Central Topic' });
      const root = doc.sheets[0].rootTopic;
      root.id = 'fan-root';
      root.children.attached = Array.from({ length: 20 }, (_, i) => {
        const number = i % 2 === 0 ? i / 2 + 1 : 20 - (i - 1) / 2;
        const branch = createTopic({ id: `main-${i}`, title: `Main Topic ${number}` });
        if (i < 6 && i % 2 === 0) branch.children.attached = [0, 1].map((j) => createTopic({ id: `sub-${i}-${j}`, title: `Subtopic ${j + 1}` }));
        if (i === 0) branch.children.attached[0].children.attached = [0, 1].map((j) => createTopic({ id: `deep-${j}`, title: `Subtopic ${j + 1}` }));
        return branch;
      });
      return doc;
    });
    const fanMap = await api('/maps', { method: 'POST', token, body: { title: fanFixture.title, document: fanFixture } });
    maps.push(fanMap.data.uid);
    await page.goto(`${BASE}/maps/${fanMap.data.uid}`);
    await waitForCanvas(page);
    const edgePaths = () => page.locator('.layer-edges [data-edge-id] > path').evaluateAll((nodes) => nodes.map((node) => [node.parentElement.getAttribute('data-edge-id'), node.getAttribute('d')]).sort());
    const rootPaths = () => page.locator('[data-edge-id^="fan-root->"] > path').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('d')));
    let rootEdges = await rootPaths();
    const starts = (paths) => new Set(paths.map((path) => path.split(' C ')[0]));
    check('20 个主分支分别从中心轮廓引出，不再每侧共点', rootEdges.length === 20 && starts(rootEdges).size === 20);
    const fork = await page.locator('[data-edge-id="main-0->sub-0-0"] > path').getAttribute('d');
    check('多层子主题使用短横线接圆角分叉', fork.includes(' H ') && fork.includes(' Q ') && fork.includes(' V '));
    const beforePaths = await edgePaths();
    await page.getByRole('button', { name: '只读预览', exact: true }).click();
    check('只读预览的端点与曲线和编辑器一致', JSON.stringify(await edgePaths()) === JSON.stringify(beforePaths));
    await page.getByRole('button', { name: '退出预览', exact: true }).click();
    const exportedPaths = await page.evaluate(async (doc) => {
      const { buildExportContext, DEFAULT_EXPORT_OPTIONS } = await import('/src/editor/export/context.ts');
      const { buildExportSvg } = await import('/src/editor/export/svg.ts');
      const svg = buildExportSvg(buildExportContext(doc, doc.sheets[0].id, { ...DEFAULT_EXPORT_OPTIONS, format: 'svg' }));
      const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
      return Array.from(parsed.querySelectorAll('.layer-edges [data-edge-id] > path')).map((node) => [node.parentElement.getAttribute('data-edge-id'), node.getAttribute('d')]).sort();
    }, fanFixture);
    check('SVG 导出与画布使用同样的分散端点、控制点和圆角分叉', JSON.stringify(exportedPaths) === JSON.stringify(beforePaths));
    if (process.env.SCREENSHOT_DIR) {
      await page.setViewportSize({ width: 1600, height: 1100 });
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(process.env.SCREENSHOT_DIR, 'wmind-branches-20.png') });
    }
    await page.locator('[data-collapse-toggle="main-0"]').click();
    check('折叠分支后端口仍分散，后代连线隐藏', starts(await rootPaths()).size === 20 && await page.locator('[data-edge-id="main-0->sub-0-0"]').count() === 0);
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    check('撤销折叠恢复原有连线几何', JSON.stringify(await edgePaths()) === JSON.stringify(beforePaths));
    await page.getByRole('button', { name: '重做', exact: true }).click();
    for (let i = 0; i < 50; i += 1) {
      const saved = (await api(`/maps/${fanMap.data.uid}`, { token })).data.document;
      if (saved.sheets[0].rootTopic.children.attached[0].collapsed) break;
      if (i === 49) throw new Error('折叠保存超时');
      await page.waitForTimeout(200);
    }
    await page.reload();
    await waitForCanvas(page);
    rootEdges = await rootPaths();
    check('保存刷新后仍为分散端点，折叠状态保留', starts(rootEdges).size === 20 && await page.locator('[data-edge-id="main-0->sub-0-0"]').count() === 0);
    check('没有浏览器异常', errors.length === 0, errors.join(' | '));
  } finally {
    await browser.close();
    for (const uid of maps) await api(`/maps/${uid}`, { method: 'DELETE', token });
  }
  return summary();
});
