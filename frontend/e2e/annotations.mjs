/**
 * 概要 / 边界 / 联系（XMind 的三个「画在节点之间」的操作）。
 *
 * 这三样东西的正确性没法靠单测证明：命令与几何都有单测（见
 * `commands/annotation.test.ts` 与 `layout/annotations.test.ts`），但
 * 「点了按钮画布上到底有没有出现那圈虚线」「改名之后画布上的字跟不跟」只有
 * 进浏览器才知道。
 *
 * 数据准备走 REST，断言读 DOM 属性（`data-boundary-id` 这些）与 SVG 文字。
 */

import {
  BASE,
  api,
  check,
  ensureUser,
  launchBrowser,
  makeUser,
  newPage,
  run,
  stamp,
  uiLogin,
  waitForCanvas,
} from './lib/harness.mjs';

const USER = makeUser('ann');

function topic(id, title, children = []) {
  return {
    id,
    title,
    titleFormat: 'plain',
    structure: null,
    style: null,
    collapsed: false,
    href: '',
    notes: { plain: '', html: '' },
    labels: [],
    markers: [],
    image: null,
    children: { attached: children, detached: [] },
    summaries: [],
    boundaries: [],
    extensions: [],
  };
}

function documentFor(title) {
  const now = new Date().toISOString();
  return {
    format: 'wmind',
    formatVersion: '1.0',
    id: `doc-${stamp}`,
    title,
    theme: {
      id: 'classic-rainbow',
      name: '经典 · 彩虹',
      category: 'classic',
      palette: { colors: ['#2E5BFF'], lineColors: ['#2E5BFF'], backgroundColor: '#FFFFFF' },
      global: { fontFamily: 'sans', fontSize: 14, lineWidth: 2, backgroundColor: '#FFFFFF' },
      centralTopic: null,
      mainTopic: null,
      subTopic: null,
      floatingTopic: null,
      summaryTopic: null,
      boundary: null,
      relationship: null,
      rainbowBranch: false,
      rainbowColors: ['#2E5BFF'],
      layout: {
        autoBalance: true,
        compact: false,
        alignSiblings: true,
        freeBranch: false,
        flexibleFloating: false,
        topicOverlap: false,
      },
    },
    sheets: [
      {
        id: 'sh-1',
        title: '画布 1',
        structure: 'mindmap',
        // 根 → A（A1、A2）、B（B1）。概要用 A1+A2，边界包 A，联系连 A1→B1。
        rootTopic: topic('tp-root', title, [
          topic('tp-a', '分支 A', [topic('tp-a1', '分支 A1'), topic('tp-a2', '分支 A2')]),
          topic('tp-b', '分支 B', [topic('tp-b1', '分支 B1')]),
          topic('tp-c', '分支 C', [topic('tp-c1', '分支 C1')]),
          topic('tp-d', '分支 D', [topic('tp-d1', '分支 D1')]),
        ]),
        floatingTopics: [],
        relationships: [],
        boundaries: [],
        summaries: [],
        themeOverride: null,
        extensions: [],
      },
    ],
    meta: { createdAt: now, updatedAt: now, app: 'wmind/1.0.0' },
    extensions: [],
  };
}

const node = (page, id) => page.locator(`g[data-topic-id="${id}"]`).first();
const toolbar = (page, name) => page.getByRole('button', { name, exact: true }).first();

// 必须点名「那块画布」，不能用 `svg.first()`：顶栏 logo 也是 `<svg>`，
// 点它等于点了个链接，页面会直接跳走，后面等节点必然超时。
const canvas = (page) => page.locator('svg[data-read-only="false"]').first();

async function selectOnly(page, ids) {
  // 先点空白清空，再逐个点（第一个不带修饰键，其余带 Shift）。
  // 画布左上角一定是空的：布局自带留白，内容整体居中。
  await canvas(page).click({ position: { x: 12, y: 12 } });
  for (const [index, id] of ids.entries()) {
    await node(page, id).click(index === 0 ? {} : { modifiers: ['Shift'] });
  }
}

async function doubleClickRelationship(page) {
  const point = await page.locator('[data-relationship-path]').first().evaluate((path) => {
    for (const fraction of [0.5, 0.25, 0.75, 0.1, 0.9]) {
      const local = path.getPointAtLength(path.getTotalLength() * fraction);
      const screen = new DOMPoint(local.x, local.y).matrixTransform(path.getScreenCTM());
      if (document.elementFromPoint(screen.x, screen.y)?.closest('[data-relationship-id]')) return { x: screen.x, y: screen.y };
    }
    throw new Error('没有可点击的联系线段');
  });
  await page.mouse.dblclick(point.x, point.y);
  await page.getByRole('textbox', { name: '联系文字', exact: true }).waitFor();
}

async function choose(page, label, option) {
  await page.getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

async function main() {
  const token = await ensureUser(USER);
  const mapTitle = `附属结构验收 ${stamp}`;
  const created = await api('/maps', {
    method: 'POST',
    token,
    body: { title: mapTitle, document: documentFor(mapTitle) },
  });
  const uid = created.data.uid;

  const browser = await launchBrowser();
  const { page, errors } = await newPage(browser);

  try {
    await uiLogin(page, USER);
    await page.goto(`${BASE}/maps/${uid}`);
    await waitForCanvas(page);
    await page.waitForTimeout(600);

    check(
      'IE-ANN-01 初始画布上没有任何附属结构',
      (await page.locator('[data-boundary-id]').count()) === 0 &&
        (await page.locator('[data-summary-id]').count()) === 0 &&
        (await page.locator('[data-relationship-id]').count()) === 0,
    );

    // ── 边界：选中 A → 点「边界」 ─────────────────────────────────────
    await selectOnly(page, ['tp-a']);
    await toolbar(page, '边界').click();
    await page.waitForTimeout(300);

    check('IE-ANN-02 点「边界」后画布上出现一圈虚线框', (await page.locator('[data-boundary-id]').count()) === 1);
    check(
      'IE-ANN-03 面板自动切到「结构」页签',
      (await page.getByRole('tab', { name: '结构' }).getAttribute('aria-selected')) === 'true',
    );

    // ── 改名：面板里改，画布上跟着变 ─────────────────────────────────
    const panel = page.getByRole('tabpanel');
    const boundaryField = panel.getByRole('textbox').first();
    await boundaryField.fill('第一阶段');
    await page.waitForTimeout(400);
    const texts = await page.evaluate(() =>
      Array.from(document.querySelectorAll('svg text')).map((el) => el.textContent ?? ''),
    );
    check('IE-ANN-04 面板里改名后画布上出现该标题', texts.includes('第一阶段'));

    // ── 概要：选中 A1 + A2 → 点「概要」 ──────────────────────────────
    await selectOnly(page, ['tp-a1', 'tp-a2']);
    await toolbar(page, '概要').click();
    await page.waitForTimeout(400);
    check('IE-ANN-05 点「概要」后画布上出现概要节点', (await page.locator('[data-summary-id]').count()) === 1);

    // 量「概要节点」这个 rect，不是整组：整组的包围盒含括号，而括号本来就
    // 贴着被概要范围的右缘（这正是括号该在的位置），拿整组去比必然失败。
    const summaryBox = await page.locator('[data-summary-id] rect').first().boundingBox();
    const a1Box = await node(page, 'tp-a1').locator('rect').first().boundingBox();
    const a2Box = await node(page, 'tp-a2').locator('rect').first().boundingBox();
    const rangeRight = a1Box !== null && a2Box !== null
      ? Math.max(a1Box.x + a1Box.width, a2Box.x + a2Box.width)
      : null;
    check(
      'IE-ANN-06 概要节点画在被概要范围的右侧',
      summaryBox !== null && rangeRight !== null && summaryBox.x > rangeRight,
      summaryBox === null || rangeRight === null
        ? '拿不到包围盒'
        : `概要左缘=${Math.round(summaryBox.x)}，范围右缘=${Math.round(rangeRight)}`,
    );

    // ── 联系：选中 A1 + B1 → 点「联系」 ──────────────────────────────
    await selectOnly(page, ['tp-a1', 'tp-b1']);
    await toolbar(page, '联系').click();
    await page.waitForTimeout(400);
    check('IE-ANN-07 点「联系」后画布上出现一条跨分支的线', (await page.locator('[data-relationship-id]').count()) === 1);

    // ── 三条都进了面板列表 ───────────────────────────────────────────
    const rowCount = await panel.locator('[data-annotation-title]').count();
    check('IE-ANN-08 面板「结构」页列出三条附属结构', rowCount === 3, `输入框 ${rowCount} 个`);

    const relationship = page.locator('[data-relationship-id]').first();
    await doubleClickRelationship(page);
    const editor = page.getByRole('textbox', { name: '联系文字', exact: true });
    await editor.fill('需要依赖');
    await editor.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, bubbles: true });
    check('IE-REL-10 输入法组合期间 Enter 不提前提交', await editor.count() === 1 && await relationship.locator('text').count() === 0);
    await editor.press('Enter');
    check('IE-REL-01 空标题联系可双击线条编辑文字', await relationship.locator('text').textContent() === '需要依赖');
    await relationship.locator('text').dblclick();
    await editor.fill('取消这次修改');
    await editor.press('Escape');
    check('IE-REL-02 双击文字可编辑，Esc 保留原文字', await relationship.locator('text').textContent() === '需要依赖');
    await relationship.focus();
    await page.keyboard.press('F2');
    await editor.fill('');
    await editor.press('Enter');
    check('IE-REL-11 F2 可编辑且允许清空标题', await relationship.locator('text').count() === 0);
    await doubleClickRelationship(page);
    await editor.fill('失焦保存');
    await page.getByRole('tab', { name: '结构', exact: true }).click();
    check('IE-REL-03 失焦提交联系文字', await relationship.locator('text').textContent() === '失焦保存');

    await choose(page, '线宽', '4 px');
    await choose(page, '线条样式', '折线');
    await choose(page, '实虚线', '点线');
    const styleFields = page.locator('[data-relationship-style]');
    await styleFields.getByRole('button', { name: '#E32925', exact: true }).click();
    const path = relationship.locator('[data-relationship-path]');
    check('IE-REL-04 联系颜色、粗细、折线与点线即时生效',
      await path.getAttribute('stroke') === '#E32925' && await path.getAttribute('stroke-width') === '4' &&
      await path.getAttribute('stroke-dasharray') === '4 8' && (await path.getAttribute('d')).includes(' L '));

    for (const [option, starts, ends] of [['无箭头', 0, 0], ['正向 →', 0, 1], ['反向 ←', 1, 0], ['双向 ↔', 1, 1]]) {
      await choose(page, '箭头方向', option);
      check(`IE-REL-05 ${option}生效`, await relationship.locator('[data-relationship-end="start"]').count() === starts &&
        await relationship.locator('[data-relationship-end="end"]').count() === ends);
    }
    await toolbar(page, '撤销').click();
    check('IE-REL-06 箭头方向支持撤销', await relationship.locator('[data-relationship-end="end"]').count() === 0);
    await toolbar(page, '重做').click();
    check('IE-REL-07 箭头方向支持重做', await relationship.locator('[data-relationship-end]').count() === 2);

    // ── 刷新后仍在（自动保存落盘） ───────────────────────────────────
    await page.waitForTimeout(1500);
    await page.reload();
    await waitForCanvas(page);
    await page.waitForTimeout(800);
    check(
      'IE-ANN-09 刷新后三条都还在',
      (await page.locator('[data-boundary-id]').count()) === 1 &&
        (await page.locator('[data-summary-id]').count()) === 1 &&
        (await page.locator('[data-relationship-id]').count()) === 1,
    );
    check('IE-REL-08 刷新后联系文字、颜色与双向箭头保留',
      await relationship.locator('text').textContent() === '失焦保存' && await path.getAttribute('stroke') === '#E32925' &&
      await relationship.locator('[data-relationship-end]').count() === 2);

    await toolbar(page, '只读预览').click();
    check('IE-REL-09 只读预览没有联系编辑命中区和输入框', await page.locator('[data-relationship-hit]').count() === 0 &&
      await page.getByRole('textbox', { name: '联系文字', exact: true }).count() === 0);
    await page.getByRole('button', { name: '退出预览', exact: true }).click();

    // ── 删除：面板里删边界 ──────────────────────────────────────────
    await page.getByRole('tab', { name: '结构' }).click();
    await page.waitForTimeout(200);
    // 必须点名「边界」那一节：面板按 概要 → 边界 → 联系 排列，
    // 直接取第一个「删除」删掉的是概要，边界还在。
    const boundarySection = page
      .getByRole('tabpanel')
      .locator('section')
      .filter({ has: page.getByRole('heading', { name: '边界' }) });
    await boundarySection.getByRole('button', { name: '删除' }).first().click();
    await page.waitForTimeout(400);
    check('IE-ANN-10 面板里删除后画布上的边界消失', (await page.locator('[data-boundary-id]').count()) === 0);

    // 截图中的场景：两个左侧分支的叶子，不能被裁成第一项的同级范围。
    await selectOnly(page, ['tp-b1', 'tp-d1']);
    await toolbar(page, '概要').click();
    await page.waitForTimeout(350);
    const summarySection = panel.locator('section').filter({ has: page.getByRole('heading', { name: '概要', exact: true }) });
    const crossRow = summarySection.locator('li').filter({ hasText: '分支 B1、分支 D1' });
    check('IE-SUM-01 跨父级选区的两个要点完整保留', await crossRow.count() === 1);
    const cross = page.locator('[data-summary-id]').last();
    const crossBox = await cross.locator('rect').boundingBox();
    const bBox = await node(page, 'tp-b1').boundingBox();
    const dBox = await node(page, 'tp-d1').boundingBox();
    check('IE-SUM-02 左侧概要向左展开且完整可见', crossBox && bBox && dBox &&
      crossBox.x >= 0 && crossBox.x + crossBox.width < Math.min(bBox.x, dBox.x));
    const noOverlap = await page.evaluate(() => {
      const rects = [...document.querySelectorAll('[data-summary-id] rect')].map((el) => el.getBoundingClientRect());
      const topics = [...document.querySelectorAll('[data-topic-id]')].map((el) => el.getBoundingClientRect());
      const overlaps = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
      return rects.every((rect, index) => !topics.some((box) => overlaps(rect, box)) &&
        !rects.slice(index + 1).some((box) => overlaps(rect, box)));
    });
    check('IE-SUM-03 概要节点避让全部主题及其他概要', noOverlap);
    await toolbar(page, '概要').click();
    await toolbar(page, '概要').click();
    check('IE-SUM-04 重复点击保持两条不同范围的概要', await page.locator('[data-summary-id]').count() === 2);
    await page.waitForTimeout(1500);
    await page.reload();
    await waitForCanvas(page);
    check('IE-SUM-05 刷新后跨分支概要仍存在', await page.locator('[data-summary-id]').count() === 2);
    if (process.env.SCREENSHOT_PATH) {
      await page.getByRole('tab', { name: '结构', exact: true }).click();
      await relationship.locator('text').click();
      await page.screenshot({ path: process.env.SCREENSHOT_PATH });
    }
    check('IE-ANN-11 全程没有页面级 JS 异常', errors.length === 0, errors.slice(0, 2).join(' | '));
  } finally {
    await browser.close();
  }
}

run(main);
