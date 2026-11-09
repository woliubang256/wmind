/**
 * M6 验收：画布无障碍。
 *
 * 这一格没法靠单测证明——`role` / `aria-*` 到底有没有被浏览器接受、方向键
 * 之后 `aria-activedescendant` 有没有真的换人，只有进浏览器才知道。单测只能
 * 钉住「选中一个节点时该说哪句话」（见 canvas-a11y.test.ts）。
 *
 * 数据准备走 REST，断言全部读 DOM 属性。
 */

import {
  BASE,
  api,
  check,
  clickNode,
  ensureUser,
  launchBrowser,
  makeUser,
  newPage,
  run,
  stamp,
  summary,
  uiLogin,
  waitForCanvas,
} from './lib/harness.mjs';

const USER = makeUser('a11y');

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
        // 根 → 分支 A（有一个子节点）、分支 B（叶子）。A 可展开、B 不可，
        // 用来验 aria-expanded 只出现在有子节点的节点上。
        rootTopic: topic('tp-root', title, [
          topic('tp-a', '分支 A', [topic('tp-a1', '分支 A1')]),
          topic('tp-b', '分支 B'),
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

/** 画布容器：有 role=tree 且带 aria-label 的那个元素。 */
function canvasTree(page) {
  return page.locator('[role="tree"][aria-describedby="editor-canvas-hint"]').first();
}

function treeItems(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('[role="treeitem"]')).map((node) => ({
      id: node.id,
      label: node.getAttribute('aria-label'),
      level: Number(node.getAttribute('aria-level')),
      selected: node.getAttribute('aria-selected'),
      expanded: node.getAttribute('aria-expanded'),
    })),
  );
}

function liveText(page) {
  return page.evaluate(() => {
    const node = document.querySelector("[data-canvas-announcer]");
    return node === null ? null : (node.textContent ?? '');
  });
}

async function main() {
  const token = await ensureUser(USER);
  const mapTitle = `无障碍验收 ${stamp}`;
  const created = await api('/maps', { method: 'POST', token, body: { title: mapTitle, document: documentFor(mapTitle) } });
  const uid = created.data.uid;

  const browser = await launchBrowser();
  const { page, errors } = await newPage(browser);

  try {
    await uiLogin(page, USER);
    await page.goto(`${BASE}/maps/${uid}`);
    await waitForCanvas(page);

    // ── 画布容器 ────────────────────────────────────────────────────────
    const tree = canvasTree(page);
    const label = await tree.getAttribute('aria-label');
    check(
      'IE-M6-A1 画布容器是 role=tree，名字里有标题与主题数',
      label !== null && label.includes(mapTitle) && label.includes('4'),
      String(label),
    );
    check(
      'IE-M6-A2 声明多选（画布支持 Ctrl+点击与全选）',
      (await tree.getAttribute('aria-multiselectable')) === 'true',
      String(await tree.getAttribute('aria-multiselectable')),
    );

    // ── treeitem 结构 ──────────────────────────────────────────────────
    let items = await treeItems(page);
    check(
      'IE-M6-A3 每个主题都是一个 treeitem（根 + A + A1 + B = 4）',
      items.length === 4,
      `count=${items.length} labels=${items.map((item) => item.label).join('|')}`,
    );

    const byLabel = (text) => items.find((item) => item.label === text);
    const root = byLabel(mapTitle);
    const a = byLabel('分支 A');
    const a1 = byLabel('分支 A1');
    const b = byLabel('分支 B');
    check(
      'IE-M6-A4 层级正确：根 1 / 分支 2 / 子分支 3',
      root?.level === 1 && a?.level === 2 && a1?.level === 3 && b?.level === 2,
      `root=${root?.level} a=${a?.level} a1=${a1?.level} b=${b?.level}`,
    );
    check(
      'IE-M6-A5 有子节点的报展开态，叶子节点不带 aria-expanded',
      a?.expanded === 'true' && b?.expanded === null && a1?.expanded === null,
      `a=${a?.expanded} b=${b?.expanded} a1=${a1?.expanded}`,
    );
    check(
      'IE-M6-A6 treeitem 的 id 有稳定前缀（供 aria-activedescendant 指向）',
      a !== undefined && a.id === 'wmind-topic-tp-a',
      String(a?.id),
    );

    // ── 选中与活动项 ────────────────────────────────────────────────────
    check('IE-M6-A7 初始没有选中，也没有播报', (await liveText(page)) === '', JSON.stringify(await liveText(page)));

    await clickNode(page, '分支 A', 150);
    items = await treeItems(page);
    check(
      'IE-M6-A8 选中的节点 aria-selected=true，其余为 false',
      items.find((item) => item.label === '分支 A')?.selected === 'true' &&
        items.filter((item) => item.selected === 'true').length === 1,
      items.map((item) => `${item.label}:${item.selected}`).join('|'),
    );

    const activeId = await tree.getAttribute('aria-activedescendant');
    const activeExists = await page.evaluate(
      (id) => document.getElementById(id) !== null,
      activeId ?? '',
    );
    check(
      'IE-M6-A9 aria-activedescendant 指向选中节点，且该 id 真实存在',
      activeId === 'wmind-topic-tp-a' && activeExists,
      `activeId=${activeId} exists=${activeExists}`,
    );

    // ── 播报 ────────────────────────────────────────────────────────────
    const said = await liveText(page);
    check(
      'IE-M6-A10 播报里有节点名与层级、子主题数',
      said.includes('分支 A') && said.includes('第 2 层') && said.includes('1 个子主题'),
      JSON.stringify(said),
    );

    // ── 键盘导航改变活动项 ──────────────────────────────────────────────
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(150);
    const afterRight = await tree.getAttribute('aria-activedescendant');
    const afterSaid = await liveText(page);
    check(
      'IE-M6-A11 方向键移动后 activedescendant 跟着换人',
      afterRight !== null && afterRight !== activeId,
      `before=${activeId} after=${afterRight}`,
    );
    check(
      'IE-M6-A12 换人之后播报也跟着更新',
      afterSaid.includes('分支 A1'),
      JSON.stringify(afterSaid),
    );

    // ── 折叠 ────────────────────────────────────────────────────────────
    await clickNode(page, '分支 A', 150);
    await page.keyboard.press('Meta+.');
    await page.waitForTimeout(250);
    items = await treeItems(page);
    check(
      'IE-M6-A13 折叠后 aria-expanded=false，被隐藏的后代不再是 treeitem',
      items.find((item) => item.label === '分支 A')?.expanded === 'false' &&
        items.every((item) => item.label !== '分支 A1'),
      `expanded=${items.find((item) => item.label === '分支 A')?.expanded} count=${items.length}`,
    );
    await page.keyboard.press('Meta+.');
    await page.waitForTimeout(250);
    items = await treeItems(page);
    check(
      'IE-M6-A14 再按一次展开，后代回到 treeitem 列表',
      items.find((item) => item.label === '分支 A')?.expanded === 'true' &&
        items.some((item) => item.label === '分支 A1'),
      `count=${items.length}`,
    );

    // ── 键位说明 ────────────────────────────────────────────────────────
    const hint = await page.evaluate(() => {
      const node = document.getElementById('editor-canvas-hint');
      if (node === null) return null;
      const rect = node.getBoundingClientRect();
      return { text: node.textContent ?? '', width: rect.width, height: rect.height };
    });
    check(
      'IE-M6-A15 aria-describedby 指向的键位说明存在且非空',
      hint !== null && hint.text.length > 10,
      JSON.stringify(hint?.text),
    );
    check(
      'IE-M6-A16 键位说明只给读屏看，不占版面',
      hint !== null && hint.width <= 1 && hint.height <= 1,
      `w=${hint?.width} h=${hint?.height}`,
    );

    // ── 键盘焦点可见 ────────────────────────────────────────────────────
    // `:focus-visible` 只在「经由键盘到达」时命中，鼠标点击与脚本 focus() 都不算。
    // 从页头的标题输入框开始按 Tab 走进去：焦点在输入框/按钮上时快捷键不拦
    // 裸 Tab（见 keymap 的两级过滤），所以这一路都是浏览器在管焦点。
    await page.getByLabel('未命名导图').click();
    let ring = null;
    for (let i = 0; i < 20; i += 1) {
      await page.keyboard.press('Tab');
      const state = await page.evaluate(() => {
        const active = document.activeElement;
        if (active === null || active.getAttribute('role') !== 'tree') return null;
        const style = getComputedStyle(active);
        return { boxShadow: style.boxShadow, outlineWidth: style.outlineWidth };
      });
      if (state !== null) {
        ring = state;
        break;
      }
    }
    check(
      'IE-M6-A17 键盘聚焦画布时有可见焦点环',
      ring !== null && ring.boxShadow !== 'none' && ring.boxShadow.includes('inset'),
      JSON.stringify(ring),
    );

    // ── 只读预览 ────────────────────────────────────────────────────────
    await page.getByRole('button', { name: '只读预览' }).click();
    await page.waitForTimeout(400);
    const previewSvg = await page.evaluate(() => {
      const svg = document.querySelector('svg[data-read-only]');
      if (svg === null) return null;
      return {
        readOnly: svg.getAttribute('data-read-only'),
        role: svg.getAttribute('role'),
        label: svg.getAttribute('aria-label'),
        items: document.querySelectorAll('[role="treeitem"]').length,
        tree: document.querySelectorAll('[role="tree"]').length,
      };
    });
    check(
      'IE-M6-A18 只读预览整张图是一个 img，名字是导图标题',
      previewSvg !== null &&
        previewSvg.readOnly === 'true' &&
        previewSvg.role === 'img' &&
        previewSvg.label === mapTitle,
      JSON.stringify(previewSvg),
    );
    check(
      'IE-M6-A19 只读预览里没有可操作的 treeitem / tree',
      previewSvg !== null && previewSvg.items === 0 && previewSvg.tree === 0,
      JSON.stringify(previewSvg),
    );

    await page.getByRole('button', { name: '退出预览' }).click();
    await page.waitForTimeout(300);

    // ── 大纲视图（回归）────────────────────────────────────────────────
    await page.getByRole('button', { name: '大纲视图' }).click();
    await page.waitForTimeout(300);
    const outline = await page.evaluate(() => {
      // aria-level 在 role=treeitem 那一层，data-outline-row 在内层的行元素上，
      // 直接查 [data-outline-row] 会拿到没有 aria-level 的节点。
      const items = Array.from(document.querySelectorAll('[role="tree"] [role="treeitem"]'));
      return {
        tree: document.querySelectorAll('[role="tree"]').length,
        rows: document.querySelectorAll('[data-outline-row]').length,
        levels: items.map((item) => item.getAttribute('aria-level')),
      };
    });
    check(
      'IE-M6-A20 大纲视图仍是 role=tree，每行带 aria-level',
      outline.tree >= 1 && outline.rows === 4 && outline.levels.join(',') === '1,2,3,2',
      JSON.stringify(outline),
    );

    // ── 键盘不能被困在画布 / 大纲里（WCAG 2.1.2）────────────────────────
    // 这两条是这一轮唯一抓出来的**真缺陷**：Tab 在画布里是「新建子主题」，
    // 初版把 Shift+Tab 也当成了它，于是 Tab 进去、Shift+Tab 想出来，结果只是
    // 又加了个节点，焦点永远出不去。大纲视图同样被全局快捷键吃掉了 Tab。
    const outlineTab = await page.evaluate(() => {
      // 焦点目标是最内层的 data-outline-row 元素，不是外层的 role=treeitem
      // （后者没有 tabindex，focus() 不生效——这里踩过一次）。
      const row = document.querySelector('[role="tree"] [data-outline-row]');
      if (!(row instanceof HTMLElement)) return false;
      row.focus();
      return document.activeElement === row;
    });
    const beforeTabRows = await page.evaluate(() => document.querySelectorAll('[role="treeitem"]').length);
    // 大纲是 roving tabindex：只有「活动行」是 0，其余 -1。所以从任意一行按 Tab
    // 可能先落到那唯一一个 tab stop 上，再按一次才真正离开。按到离开为止，最多三次。
    let leftOutline = false;
    let tabPresses = 0;
    const tabTrace = [];
    for (let i = 0; i < 3; i += 1) {
      await page.keyboard.press('Tab');
      await page.waitForTimeout(150);
      tabPresses += 1;
      const state = await page.evaluate(() => {
        const active = document.activeElement;
        return {
          tag: active?.tagName ?? null,
          role: active?.getAttribute?.('role') ?? null,
          row: active?.getAttribute?.('data-outline-row') ?? null,
          inside: active?.closest?.('[role="tree"]') !== null,
          body: active === document.body,
        };
      });
      tabTrace.push(state);
      if (!state.inside || state.body) {
        leftOutline = true;
        break;
      }
    }
    const afterTab = await page.evaluate(() => ({
      rows: document.querySelectorAll('[role="treeitem"]').length,
      editing: document.querySelectorAll('textarea').length,
    }));
    check(
      'IE-M6-A22 大纲里按 Tab 是离开控件，不是新建子主题',
      outlineTab && leftOutline && afterTab.rows === beforeTabRows && afterTab.editing === 0,
      `focusLeft=${leftOutline} presses=${tabPresses} rows=${beforeTabRows}->${afterTab.rows} textarea=${afterTab.editing} trace=${JSON.stringify(tabTrace)}`,
    );

    await page.getByRole('button', { name: '大纲视图' }).click();
    await page.waitForTimeout(300);
    await canvasTree(page).click({ position: { x: 30, y: 30 } });
    const beforeShiftTab = await page.evaluate(() => document.querySelectorAll('[role="treeitem"]').length);
    await page.keyboard.press('Shift+Tab');
    await page.waitForTimeout(200);
    const afterShiftTab = await page.evaluate(() => ({
      stillOnCanvas: document.activeElement?.getAttribute('role') === 'tree',
      rows: document.querySelectorAll('[role="treeitem"]').length,
      editing: document.querySelectorAll('textarea').length,
    }));
    check(
      'IE-M6-A23 画布里 Shift+Tab 能退出，且不会偷偷加节点',
      afterShiftTab.stillOnCanvas === false &&
        afterShiftTab.rows === beforeShiftTab &&
        afterShiftTab.editing === 0,
      JSON.stringify({ before: beforeShiftTab, after: afterShiftTab }),
    );

    check('IE-M6-A21 全程无页面错误', errors.length === 0, errors.join(' | '));
  } finally {
    await browser.close();
  }

  return summary();
}

run(main);
