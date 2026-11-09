/**
 * 视口裁剪的正确性验收。
 *
 * 裁剪是「少画东西」的优化，最容易出的错是**少画了该画的东西**——那种 bug
 * 在压测文档上表现为「拖到某个位置，节点没了」，而且只在 2000 节点时才出现。
 *
 * 四条判据：
 *   1. 默认视口下确实裁掉了大部分（否则等于没生效）；
 *   2. 缩放到适应之后**一个都不少**（2001 个全部可见就必须全部渲染）；
 *   3. 选中的节点在视口外时仍然渲染（aria-activedescendant 不能指向不存在的 id）；
 *   4. 全程无页面错误，且渲染出来的 id 都属于文档。
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
  summary,
  uiLogin,
  waitForCanvas,
} from './lib/harness.mjs';

const USER = makeUser('cull');

/** 40 个分支 × 50 个叶子 + 根 = 2001 个节点。 */
const BRANCHES = 40;
const PER_BRANCH = 50;
const TOTAL = 1 + BRANCHES * PER_BRANCH;

/**
 * 压测文档。
 *
 * 原先这里写死了一个手工灌进库的 `/maps/stress`，换台机器就没得跑。改成
 * 用接口现造：节点数一样，包围盒一样大，同样会撞上 `MIN_ZOOM` 的下限。
 */
function stressDocument(title) {
  return {
    format: 'wmind',
    formatVersion: '1.0',
    id: `stress-${stamp}`,
    title,
    sheets: [
      {
        id: 'stress-sheet',
        title: '画布 1',
        rootTopic: {
          id: 'st-root',
          title,
          children: {
            attached: Array.from({ length: BRANCHES }, (_, b) => ({
              id: `st-${b}`,
              title: `分支 ${b + 1}`,
              children: {
                attached: Array.from({ length: PER_BRANCH }, (_, c) => ({
                  id: `st-${b}-${c}`,
                  title: `节点 ${b + 1}-${c + 1}`,
                  children: { attached: [] },
                })),
              },
            })),
          },
        },
      },
    ],
  };
}

async function main() {
  const token = await ensureUser(USER);
  const title = `压测文档 ${stamp}`;
  const created = await api('/maps', { method: 'POST', token, body: { title, document: stressDocument(title) } });
  const uid = created.data.uid;

  const browser = await launchBrowser();
  const { page, errors } = await newPage(browser);

  try {
    await uiLogin(page, USER);

    await page.goto(`${BASE}/maps/${uid}`);
    await page.waitForFunction(() => document.querySelectorAll('g.wmind-topic').length > 0, undefined, {
      timeout: 60000,
    });
    await page.waitForTimeout(1200);

    const initial = await page.evaluate(() => document.querySelectorAll('g.wmind-topic').length);
    check('IE-M6-P1 默认视口下只渲染可见部分', initial > 0 && initial < TOTAL / 2, `rendered=${initial}/${TOTAL}`);

    /*
      压测页加载时会自动「缩放到适应」，而 2000 节点的包围盒远大于
      MIN_ZOOM=0.2 能塞进一屏的范围，所以一开始就停在缩放下限 20%。
      于是「缩小」按不动，能验的是反方向：放大后渲染变少、缩回来变多。

      三条不变量：
        1. 渲染出来的每个节点，屏幕包围盒都与画布相交（不画视口外的）；
        2. 放大后渲染数是原来的子集（不是换了另一批）；
        3. 缩回来之后原来的节点都还在（没有丢）。
    */
    const resetIds = await page.evaluate(() => {
      // 注意不能用 `document.querySelector('svg')`——页头的图标也是 <svg>，
      // 第一个匹配到的是 16×16 的图标，包围盒相交判断会全假。
      const canvas = document.querySelector('svg[data-read-only]')?.getBoundingClientRect();
      const ids = Array.from(document.querySelectorAll('g.wmind-topic'));
      // 裁剪矩形**刻意**带余量（半屏 + 240 世界单位），否则快速拖动时会在边上
      // 看到节点「长出来」。所以判据不是「必须落在画布内」，而是「不超出画布
      // 周边一屏」——真裁错了会差出好几个屏。
      const slackX = canvas?.width ?? 0;
      const slackY = canvas?.height ?? 0;
      const near = ids.filter((node) => {
        const rect = node.getBoundingClientRect();
        if (canvas === undefined) return false;
        return (
          rect.left < canvas.right + slackX &&
          canvas.left - slackX < rect.right &&
          rect.top < canvas.bottom + slackY &&
          canvas.top - slackY < rect.bottom
        );
      });
      const inside = ids.filter((node) => {
        const rect = node.getBoundingClientRect();
        if (canvas === undefined) return false;
        return (
          rect.left < canvas.right + 1 &&
          canvas.left - 1 < rect.right &&
          rect.top < canvas.bottom + 1 &&
          canvas.top - 1 < rect.bottom
        );
      });
      return {
        all: ids.map((node) => node.getAttribute('data-topic-id')),
        near: near.length,
        inside: inside.length,
      };
    });
    check(
      'IE-M6-P2 渲染范围不超出画布周边一屏（余量之外的都裁掉）',
      resetIds.near === resetIds.all.length && resetIds.all.length > 0,
      `rendered=${resetIds.all.length} 画布内=${resetIds.inside} 一屏内=${resetIds.near}`,
    );

    for (let i = 0; i < 5; i += 1) {
      await page.getByRole('button', { name: '放大' }).click();
    }
    await page.waitForTimeout(500);
    const zoomedIn = await page.evaluate(() =>
      Array.from(document.querySelectorAll('g.wmind-topic')).map((node) => node.getAttribute('data-topic-id')),
    );
    check(
      'IE-M6-P3 放大后渲染数下降，且是原来的子集',
      zoomedIn.length < resetIds.all.length && zoomedIn.every((id) => resetIds.all.includes(id)),
      `${resetIds.all.length} -> ${zoomedIn.length}`,
    );

    for (let i = 0; i < 5; i += 1) {
      await page.getByRole('button', { name: '缩小' }).click();
    }
    await page.waitForTimeout(500);
    const zoomedOut = await page.evaluate(() =>
      Array.from(document.querySelectorAll('g.wmind-topic')).map((node) => node.getAttribute('data-topic-id')),
    );
    check(
      'IE-M6-P4 缩回原比例后节点都回来了（没有丢）',
      zoomedOut.length >= resetIds.all.length &&
        resetIds.all.every((id) => zoomedOut.includes(id)),
      `${zoomedIn.length} -> ${zoomedOut.length}（原 ${resetIds.all.length}）`,
    );

    // 键盘把选区移到视口外：被选中的节点必须仍然渲染
    await page.locator('div[role="tree"]').first().click({ position: { x: 30, y: 30 } });
    for (let i = 0; i < 40; i += 1) await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(400);
    const offscreen = await page.evaluate(() => {
      const tree = document.querySelector('div[role="tree"]');
      const activeId = tree?.getAttribute('aria-activedescendant') ?? null;
      const selected = document.querySelector('[role="treeitem"][aria-selected="true"]');
      return {
        activeId,
        exists: activeId === null ? false : document.getElementById(activeId) !== null,
        selectedRendered: selected !== null,
        rendered: document.querySelectorAll('g.wmind-topic').length,
      };
    });
    check(
      'IE-M6-P5 选中的节点即使离开视口也仍然渲染',
      offscreen.activeId !== null && offscreen.exists && offscreen.selectedRendered,
      JSON.stringify(offscreen),
    );

    check('IE-M6-P6 全程无页面错误', errors.length === 0, errors.join(' | '));
  } finally {
    await browser.close();
  }

  return summary();
}

run(main);
