/** 独立 API 夹具：不读写真实导图，覆盖同画布重载与草稿视角恢复。 */
import { BASE, check, launchBrowser, newContext, newPage, run, summary } from './lib/harness.mjs';

const authorView = { centerX: 85, centerY: -40, zoom: 1.25 };
const replacementView = { centerX: -175, centerY: 230, zoom: 0.75 };
const draftView = { centerX: 330, centerY: -110, zoom: 1.75 };
const baseDocument = () => ({
  format: 'wmind', formatVersion: '1.0', id: 'reload-doc', title: '重载视图测试',
  sheets: [{ id: 'first', title: '原画布', structure: 'mindmap', rootTopic: {
    id: 'root', title: '原中心主题', children: { attached: [{ id: 'leaf', title: '子主题', children: { attached: [], detached: [] } }], detached: [] },
  } }],
  viewState: { activeSheetId: 'first', sheets: { first: authorView } },
});

async function fixture(page, uid, conflictStructure) {
  let document = baseDocument();
  let version = 1;
  let conflict = conflictStructure !== undefined;
  const updatedAt = new Date(Date.now() - 60_000).toISOString();
  const puts = [];
  let reads = 0;
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace('/api/v1', '');
    const user = { uid: 'reload-user', username: 'fixture', nickname: '', email: '', role: 'user', status: 'active', settings: {} };
    let data = [];
    if (path === '/auth/refresh') data = { accessToken: 'fixture-token', expiresIn: 900, user };
    else if (path === '/auth/me') data = user;
    else if (path === '/site/config') data = { siteName: 'wmind', brand: 'wmind', exportEnabled: true, shareEnabled: true };
    else if (path === `/maps/${uid}`) {
      if (request.method() === 'PUT') {
        const mutation = request.postDataJSON();
        puts.push(mutation);
        if (conflict) {
          conflict = false;
          // 从客户端已经归一化的副本生成完整服务端版本，保留同一画布 ID。
          document = structuredClone(mutation.document);
          document.sheets[0].structure = conflictStructure;
          document.sheets[0].rootTopic.title = '服务端中心主题';
          document.viewState = { activeSheetId: 'first', sheets: { first: replacementView } };
          version = 3;
          return route.fulfill({ status: 409, json: { error: { code: 'MAP_VERSION_CONFLICT', message: 'Document changed', details: { currentVersion: version, currentUpdatedAt: '2026-10-25T10:00:00Z' } } } });
        }
        document = mutation.document;
        version += 1;
      } else reads += 1;
      data = { uid, title: document.title, document, version, nodeCount: 2, sizeBytes: 2048, thumbnailUrl: '/fixture.png', createdAt: updatedAt, updatedAt };
    } else if (path.endsWith('/thumbnail')) data = {};
    await route.fulfill({ json: { data } });
  });
  return { puts, reads: () => reads, document: () => document };
}

async function currentView(page) {
  return page.locator('#editor-canvas-surface').evaluate((node) => {
    const matrix = node.querySelector('g.viewport').transform.baseVal.consolidate().matrix;
    return { centerX: (node.clientWidth / 2 - matrix.e) / matrix.a, centerY: (node.clientHeight / 2 - matrix.f) / matrix.a, zoom: matrix.a };
  });
}
const sameView = (actual, expected) => Object.keys(expected).every((key) => Math.abs(actual[key] - expected[key]) < 0.001);
async function flush(page) {
  await page.getByRole('tree').focus();
  await page.keyboard.press('Control+s');
}
async function settled(page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

run(async () => {
  const browser = await launchBrowser();
  try {
    for (const structure of ['mindmap', 'org-chart']) {
      const context = await newContext(browser);
      const { page, errors } = await newPage(browser, { context });
      const state = await fixture(page, `reload-${structure}`, structure);
      await page.goto(`${BASE}/maps/reload-${structure}`);
      await page.locator('[data-topic-id="root"]').waitFor();
      await settled(page);
      check(`${structure} 首屏恢复作者视图`, sameView(await currentView(page), authorView));
      await page.waitForTimeout(5500);
      check(`${structure} 首屏纯查看不产生保存`, state.puts.length === 0);
      await page.setViewportSize({ width: 1090, height: 740 });
      await page.waitForTimeout(5500);
      check(`${structure} resize保留世界中心与缩放`, sameView(await currentView(page), authorView));
      check(`${structure} resize不产生保存`, state.puts.length === 0);

      // 主动导航建立旧的本地缓存，并让一次正常保存收到版本冲突。
      await page.getByRole('combobox', { name: '快捷缩放', exact: true }).click();
      await page.getByRole('option', { name: '150%', exact: true }).click();
      await flush(page);
      await page.waitForTimeout(1000);
      check(`${structure} 导航后视口已变更`, Math.abs((await currentView(page)).zoom - 1.5) < 0.001, `PUT=${state.puts.length}`);
      const dialog = page.getByRole('dialog', { name: '这张导图已在别处修改', exact: true });
      await dialog.waitFor();
      check(`${structure} 主动导航参与保存并触发冲突`, state.puts.length === 1 && state.puts[0].document.viewState.sheets.first.zoom === 1.5);
      await dialog.getByRole('button', { name: '放弃我的修改', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      await settled(page);
      check(`${structure} 采用服务器版本确实重新读取文档`, state.reads() === 2 && await page.locator('[data-topic-id="root"]').getAttribute('aria-label') === '服务端中心主题');
      const restored = await currentView(page);
      check(`${structure} 同画布重载使用服务器视角而非旧缓存`, sameView(restored, replacementView), JSON.stringify(restored));
      check(`${structure} 服务端结构同步恢复`, await page.locator('[data-topic-id="leaf"]').getAttribute('data-topic-side') === (structure === 'org-chart' ? 'bottom' : 'right'));
      await page.waitForTimeout(5500);
      await flush(page);
      await settled(page);
      check(`${structure} 丢弃本地后不重新写回或覆盖服务端视图`, state.puts.length === 1 && sameView(state.document().viewState.sheets.first, replacementView));
      check(`${structure} 无页面异常`, errors.length === 0, errors.join('\n'));
      await context.close();
    }

    const context = await newContext(browser);
    const { page, errors } = await newPage(browser, { context });
    const state = await fixture(page, 'reload-draft');
    const draft = baseDocument();
    draft.sheets[0].rootTopic.title = '草稿中心主题';
    draft.viewState.sheets.first = draftView;
    await context.addInitScript(({ draft, savedAt }) => localStorage.setItem('wmind:draft:reload-draft', JSON.stringify({ uid: 'reload-draft', document: draft, savedAt })), { draft, savedAt: Date.now() });
    await page.goto(`${BASE}/maps/reload-draft`);
    await page.locator('[data-topic-id="root"]').waitFor();
    const restore = page.getByRole('button', { name: '恢复', exact: true });
    await restore.waitFor();
    check('草稿提示不自动替换服务器视角', sameView(await currentView(page), authorView) && state.puts.length === 0);
    // 改动旧本地缓存但不等防抖保存；明确恢复草稿应覆盖它。
    await page.getByRole('combobox', { name: '快捷缩放', exact: true }).click();
    await page.getByRole('option', { name: '150%', exact: true }).click();
    await restore.click();
    await restore.waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.body.innerText.includes('已保存'));
    await settled(page);
    const restored = await currentView(page);
    check('恢复草稿使用草稿视角而非原服务端或导航缓存', sameView(restored, draftView), JSON.stringify(restored));
    check('草稿恢复立即保存草稿内容与原始视角', state.puts.length === 1 && sameView(state.puts[0].document.viewState.sheets.first, draftView) && state.puts[0].document.sheets[0].rootTopic.title === '草稿中心主题');
    check('草稿恢复无页面异常', errors.length === 0, errors.join('\n'));
    await context.close();
    return summary();
  } finally { await browser.close(); }
});
