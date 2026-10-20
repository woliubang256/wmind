/**
 * M5 验收：多画布 + 大纲视图 + ZEN 模式。
 *
 * 判据 5「大纲视图与画布编辑实时同步」、判据 6「多画布切换不丢失未保存内容」
 * 都必须走真实界面：同步这件事在架构上是「两边读同一份文档」，只有在浏览器里
 * 才能证明投影没接错。
 *
 * 数据准备走 REST，断言走 DOM。
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
  svgTexts,
  uiLogin,
  waitForCanvas,
} from './lib/harness.mjs';

const USER = makeUser('sheets');

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
        rootTopic: {
          id: 'tp-root',
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
          children: {
            attached: [
              {
                id: 'tp-a',
                title: '分支 A',
                titleFormat: 'plain',
                structure: null,
                style: null,
                collapsed: false,
                href: '',
                notes: { plain: '', html: '' },
                labels: [],
                markers: [],
                image: null,
                children: { attached: [], detached: [] },
                summaries: [],
                boundaries: [],
                extensions: [],
              },
              {
                id: 'tp-b',
                title: '分支 B',
                titleFormat: 'plain',
                structure: null,
                style: null,
                collapsed: false,
                href: '',
                notes: { plain: '', html: '' },
                labels: [],
                markers: [],
                image: null,
                children: { attached: [], detached: [] },
                summaries: [],
                boundaries: [],
                extensions: [],
              },
            ],
            detached: [],
          },
          summaries: [],
          boundaries: [],
          extensions: [],
        },
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

/** 在选中节点下加一个子主题并落字。 */
async function addChild(page, parentText, childText) {
  await clickNode(page, parentText);
  await page.keyboard.press('Tab');
  await page.waitForSelector('textarea', { timeout: 10000 });
  await page.keyboard.type(childText);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(120);
}

function tabLabels(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-sheet-tab]')).map((node) => node.textContent ?? ''),
  );
}

function activeTab(page) {
  return page.evaluate(() => {
    const node = document.querySelector('[data-sheet-tab][aria-selected="true"]');
    return node === null ? null : node.textContent;
  });
}

function nodeCountText(page) {
  return page.evaluate(() => {
    const footer = document.querySelector('footer');
    return footer === null ? null : (footer.textContent ?? '');
  });
}

async function main() {
  const token = await ensureUser(USER);
  const mapTitle = `多画布验收 ${stamp}`;
  const created = await api('/maps', { method: 'POST', token, body: { title: mapTitle, document: documentFor(mapTitle) } });
  const uid = created.data.uid;

  const browser = await launchBrowser();
  const { page, errors } = await newPage(browser);

  try {
    await uiLogin(page, USER);
    await page.goto(`${BASE}/maps/${uid}`);
    await waitForCanvas(page);

    // ── 多画布 ───────────────────────────────────────────────────────────
    let labels = await tabLabels(page);
    check('IE-M5-13 编辑器底部有画布标签栏，初始一张', labels.length === 1 && labels[0] === '画布 1', labels.join('|'));

    await page.getByRole('button', { name: '新建画布' }).click();
    await page.waitForTimeout(200);
    labels = await tabLabels(page);
    check(
      'IE-M5-14 新建画布后自动切到新画布',
      labels.length === 2 && labels[1] === '画布 2' && (await activeTab(page)) === '画布 2',
      labels.join('|'),
    );

    const emptyTexts = await svgTexts(page);
    check(
      'IE-M5-15 新画布是空的（只有中心主题）',
      emptyTexts.length === 1 && (await nodeCountText(page) ?? '').includes('1 个节点'),
      `${emptyTexts.join('|')} / ${await nodeCountText(page)}`,
    );

    await addChild(page, '中心主题', '画布二节点');
    let texts = await svgTexts(page);
    check('IE-M5-16 新画布上能加节点', texts.includes('画布二节点'), texts.join('|'));

    // 不等待保存就切走再切回：内容不该丢（判据 6）。
    await page.locator('[data-sheet-tab]').first().click();
    await page.waitForTimeout(150);
    const sheetOneTexts = await svgTexts(page);
    check(
      'IE-M5-17 切回画布 1 看到的是画布 1 的内容',
      sheetOneTexts.includes('分支 A') && !sheetOneTexts.includes('画布二节点'),
      sheetOneTexts.join('|'),
    );

    await page.locator('[data-sheet-tab]').nth(1).click();
    await page.waitForTimeout(150);
    texts = await svgTexts(page);
    check('IE-M5-18 再切回画布 2，未保存的节点还在', texts.includes('画布二节点'), texts.join('|'));

    // 画布 2 的中心主题改名，不能改到导图标题上。
    await clickNode(page, '中心主题');
    await page.keyboard.press('F2');
    await page.waitForSelector('textarea', { timeout: 10000 });
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('第二张画布');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(150);
    const headerTitle = await page.locator('header input').first().inputValue();
    texts = await svgTexts(page);
    check(
      'IE-M5-19 改第二张画布的中心主题不会改掉导图标题',
      texts.includes('第二张画布') && headerTitle === mapTitle,
      `${texts.join('|')} / 标题=${headerTitle}`,
    );

    // 双击标签改名。
    const secondTab = page.locator('[data-sheet-tab]').nth(1);
    await secondTab.dblclick();
    const renameInput = page.getByLabel('重命名画布');
    await renameInput.waitFor({ timeout: 5000 });
    await renameInput.fill('技术方案');
    await renameInput.press('Enter');
    await page.waitForTimeout(200);
    labels = await tabLabels(page);
    check('IE-M5-20 双击标签能改名', labels[1] === '技术方案', labels.join('|'));

    // 键盘调整顺序：Alt+←。
    await page.locator('[data-sheet-tab]').nth(1).focus();
    await page.keyboard.press('Alt+ArrowLeft');
    await page.waitForTimeout(200);
    labels = await tabLabels(page);
    check('IE-M5-21 Alt+← 能把当前标签往前挪', labels[0] === '技术方案' && labels[1] === '画布 1', labels.join('|'));

    // 拖动排序：把第一张拖到第二位。
    await page.locator('[data-sheet-tab]').nth(0).dragTo(page.locator('[data-sheet-tab]').nth(1));
    await page.waitForTimeout(250);
    labels = await tabLabels(page);
    check('IE-M5-22 拖动标签能排序', labels[0] === '画布 1' && labels[1] === '技术方案', labels.join('|'));

    // 删有内容的画布要确认；先取消。
    await page.locator('[data-sheet-tab]').nth(1).click();
    await page.waitForTimeout(150);
    await page.getByRole('button', { name: '删除画布' }).click();
    const dialog = page.locator('dialog[open]').filter({ hasText: '删除画布' });
    await dialog.waitFor({ timeout: 5000 });
    check('IE-M5-23 删除有内容的画布要二次确认', await dialog.isVisible());
    await dialog.getByRole('button', { name: '取消' }).click();
    await page.waitForTimeout(150);
    check('IE-M5-24 取消后画布还在', (await tabLabels(page)).length === 2);

    // 确认删除，然后撤销。
    await page.getByRole('button', { name: '删除画布' }).click();
    const dialog2 = page.locator('dialog[open]').filter({ hasText: '删除画布' });
    await dialog2.waitFor({ timeout: 5000 });
    await dialog2.getByRole('button', { name: '删除画布' }).click();
    await page.waitForTimeout(250);
    labels = await tabLabels(page);
    check('IE-M5-25 确认后画布消失，剩下的那张成为当前画布', labels.length === 1 && (await activeTab(page)) === '画布 1', labels.join('|'));

    // 快捷键监听挂在编辑器根节点上：先把焦点放回画布，否则 ⌘Z 收不到。
    await clickNode(page, '分支 A');
    await page.keyboard.press('ControlOrMeta+z');
    await page.waitForTimeout(250);
    labels = await tabLabels(page);
    check('IE-M5-26 ⌘Z 撤销能恢复被删的画布', labels.length === 2 && labels.includes('技术方案'), labels.join('|'));
    // 只剩一张时没有删除按钮。
    await page.locator('[data-sheet-tab]').nth(1).click();
    await page.getByRole('button', { name: '删除画布' }).click();
    const dialog3 = page.locator('dialog[open]').filter({ hasText: '删除画布' });
    await dialog3.waitFor({ timeout: 5000 });
    await dialog3.getByRole('button', { name: '删除画布' }).click();
    await page.waitForTimeout(250);
    const deleteButtons = await page.getByRole('button', { name: '删除画布' }).count();
    check('IE-M5-27 只剩一张画布时没有删除入口', deleteButtons === 0, `count=${deleteButtons}`);

    // ── 持久化：刷新后两张画布与内容都在 ────────────────────────────────
    await page.getByRole('button', { name: '新建画布' }).click();
    await page.waitForTimeout(150);
    await addChild(page, '中心主题', '持久化节点');
    await page.waitForFunction(
      () => (document.querySelector('footer')?.textContent ?? '').includes('已保存'),
      undefined,
      { timeout: 20000 },
    );
    await page.reload();
    await waitForCanvas(page);
    labels = await tabLabels(page);
    // 刷新后落在第一张画布上，所以要切到第二张才能验它的内容。
    await page.locator('[data-sheet-tab]').nth(1).click();
    await page.waitForTimeout(200);
    const reloadedTexts = await svgTexts(page);
    check(
      'IE-M5-28 刷新后两张画布都在，第二张的内容也还在',
      labels.length === 2 && reloadedTexts.includes('持久化节点'),
      `${labels.join('|')} / ${reloadedTexts.join('|')}`,
    );

    // ── 大纲视图 ─────────────────────────────────────────────────────────
    await page.locator('[data-sheet-tab]').first().click();
    await page.waitForTimeout(150);
    await page.getByRole('button', { name: '大纲视图' }).click();
    await page.getByRole('tree').waitFor({ timeout: 10000 });
    const rows = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-outline-row]')).map((node) => node.textContent ?? ''),
    );
    check(
      'IE-M5-29 大纲列出整棵树（根 + 两个分支）',
      rows.length === 3 && rows.includes('分支 A'),
      rows.join('|'),
    );
    const levels = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[role="treeitem"]')).map((node) => node.getAttribute('aria-level')),
    );
    check('IE-M5-30 大纲有层级（aria-level 1/2）', levels.join(',') === '1,2,2', levels.join(','));

    // 大纲 → 画布
    await page.locator('[data-outline-row]').nth(1).dblclick();
    const outlineInput = page.getByLabel('编辑主题文字');
    await outlineInput.waitFor({ timeout: 5000 });
    await outlineInput.fill('大纲改的分支');
    await outlineInput.press('Enter');
    await page.waitForTimeout(200);
    await page.getByRole('button', { name: '大纲视图' }).click();
    await waitForCanvas(page);
    texts = await svgTexts(page);
    check('IE-M5-31 大纲里改文字，画布同步', texts.includes('大纲改的分支') && !texts.includes('分支 A'), texts.join('|'));

    // 画布 → 大纲
    await clickNode(page, '分支 B');
    await page.keyboard.press('F2');
    await page.waitForSelector('textarea', { timeout: 10000 });
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('画布改的分支');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
    await page.getByRole('button', { name: '大纲视图' }).click();
    await page.getByRole('tree').waitFor({ timeout: 10000 });
    const rowsAfter = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-outline-row]')).map((node) => node.textContent ?? ''),
    );
    check('IE-M5-32 画布上改文字，大纲同步', rowsAfter.includes('画布改的分支'), rowsAfter.join('|'));

    // 缩进：把第二个分支降到第一个分支下面（第一行没有上一个兄弟，缩不了）。
    await page.locator('[data-outline-row]').nth(2).click();
    await page.keyboard.press('ControlOrMeta+]');
    await page.waitForTimeout(200);
    const levelsAfter = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[role="treeitem"]')).map((node) => node.getAttribute('aria-level')),
    );
    check('IE-M5-33 Ctrl+] 降级（层级从 2 变成 3）', levelsAfter.join(',') === '1,2,3', levelsAfter.join(','));

    // 折叠：折叠根节点后大纲只剩一行。
    await page.locator('[role="treeitem"] button[aria-expanded]').first().click();
    await page.waitForTimeout(200);
    const collapsedRows = await page.evaluate(() => document.querySelectorAll('[data-outline-row]').length);
    check('IE-M5-34 折叠后大纲隐藏后代', collapsedRows === 1, `rows=${collapsedRows}`);
    await page.locator('[role="treeitem"] button[aria-expanded]').first().click();
    await page.waitForTimeout(150);

    // ── ZEN ──────────────────────────────────────────────────────────────
    await page.getByRole('button', { name: '大纲视图' }).click();
    await waitForCanvas(page);
    await page.getByRole('button', { name: '进入 ZEN 模式' }).click();
    await page.waitForTimeout(250);
    const zen = await page.evaluate(() => ({
      headerInput: document.querySelectorAll('header input').length,
      footer: document.querySelectorAll('footer').length,
      tabs: document.querySelectorAll('[data-sheet-tab]').length,
      svg: document.querySelectorAll('svg text').length,
    }));
    check(
      'IE-M5-35 ZEN 收起页头、标签栏、页脚，画布还在',
      zen.headerInput === 0 && zen.footer === 0 && zen.tabs === 0 && zen.svg > 0,
      JSON.stringify(zen),
    );

    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
    const restored = await page.evaluate(() => ({
      headerInput: document.querySelectorAll('header input').length,
      footer: document.querySelectorAll('footer').length,
      tabs: document.querySelectorAll('[data-sheet-tab]').length,
    }));
    check(
      'IE-M5-36 Esc 退出 ZEN，界面恢复',
      restored.headerInput === 1 && restored.footer === 1 && restored.tabs === 2,
      JSON.stringify(restored),
    );

    check('IE-M5-37 全程没有页面级 JS 异常', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    await browser.close();
  }

  return summary();
}

run(main);
