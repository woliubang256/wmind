import { BASE, check, launchBrowser, newPage, run, summary, waitForCanvas } from './lib/harness.mjs';

// 截图中的四个入口共用 Select。接口全部拦截，不写开发数据库。
const metrics = (list) => list.evaluate((node) => {
  const box = node.getBoundingClientRect();
  return {
    client: node.clientHeight, scroll: node.scrollHeight, scrollTop: node.scrollTop,
    top: box.top, bottom: box.bottom, viewport: innerHeight,
  };
});

async function shortMenu(page, trigger, name, above = false) {
  await trigger.click();
  const list = page.getByRole('listbox');
  const sizes = await metrics(list);
  check(`${name}完整显示且无滚动溢出`, sizes.client === sizes.scroll, JSON.stringify(sizes));
  const box = await trigger.boundingBox();
  check(`${name}位置${above ? '向上' : '向下'}且保留视口边距`,
    sizes.top >= 8 && sizes.bottom <= sizes.viewport - 8 && (above ? sizes.bottom <= box.y - 3 : sizes.top >= box.y + box.height + 3),
    JSON.stringify(sizes));
  await page.keyboard.press('Escape');
  check(`${name}关闭后焦点返回入口`, await trigger.evaluate((node) => document.activeElement === node));
}

run(async () => {
  const browser = await launchBrowser();
  try {
    const { page, errors } = await newPage(browser);
    let document;
    await page.route('**/api/v1/**', async (route) => {
      const path = new URL(route.request().url()).pathname.replace('/api/v1', '');
      let data = [];
      if (path === '/auth/me' || path === '/auth/refresh') {
        data = { uid: 'select-user', username: 'select', nickname: '菜单验收', email: '', role: 'user', status: 'active' };
        if (path === '/auth/refresh') data = { accessToken: 'fixture-token', expiresIn: 900, user: data };
      }
      if (path === '/site/config') data = { siteName: 'wmind', brand: 'wmind', passwordMinLength: 8, exportEnabled: true };
      if (path === '/auth/2fa/status') data = { enabled: false };
      if (path === '/maps/menu-fixture') data = {
        uid: 'menu-fixture', title: document.title, document, version: 1, nodeCount: 1,
        thumbnailUrl: '/menu-fixture.png', createdAt: '2026-10-24T00:00:00Z', updatedAt: '2026-10-24T00:00:00Z',
      };
      if (path.endsWith('/thumbnail')) return route.fulfill({ status: 204 });
      await route.fulfill({ json: { data, pagination: { page: 1, pageSize: 20, total: 0, totalPages: 1 } } });
    });
    await page.goto(`${BASE}/account`);
    await page.getByRole('heading', { name: '个人设置', exact: true }).waitFor();
    await shortMenu(page, page.locator('header').getByRole('combobox'), '语言菜单（3项）');
    document = await page.evaluate(async () => {
      const { createDocument } = await import('/src/editor/model/create.ts');
      return createDocument({ title: '下拉溢出验收' });
    });
    await page.goto(`${BASE}/maps/menu-fixture`);
    await waitForCanvas(page);
    await shortMenu(page, page.getByRole('combobox', { name: '快捷缩放', exact: true }), '快捷缩放（6项）', true);
    const panel = page.locator('#editor-canvas-panel');
    await panel.getByRole('tab', { name: '样式', exact: true }).click();
    const structure = panel.getByRole('combobox', { name: '结构', exact: true });
    await shortMenu(page, structure, '结构（9项）');
    await page.getByRole('button', { name: '导出', exact: true }).click();
    const dialog = page.locator('dialog[open]');
    await dialog.waitFor({ timeout: 10_000 }).catch(async (error) => {
      console.error('导出弹窗诊断', errors, await page.locator('body').innerText());
      throw error;
    });
    const scale = page.getByRole('combobox', { name: '倍率', exact: true });
    await shortMenu(page, scale, '导出倍率（5项）');
    await page.keyboard.press('Escape');

    // 高度受限时仍需滚动，键盘首尾跳转必须滚到活动项；不能靠隐藏滚动条修复。
    await page.setViewportSize({ width: 900, height: 300 });
    await structure.click();
    const list = page.getByRole('listbox');
    const limited = await metrics(list);
    check('空间不足时结构菜单仍可滚动且不越界', limited.scroll > limited.client && limited.top >= 8 && limited.bottom <= 292, JSON.stringify(limited));
    await page.keyboard.press('End');
    const lastVisible = await list.evaluate((node) => {
      const item = document.getElementById(node.getAttribute('aria-activedescendant'));
      const box = node.getBoundingClientRect(); const active = item.getBoundingClientRect();
      return active.top >= box.top + node.clientTop && active.bottom <= box.top + node.clientTop + node.clientHeight;
    });
    check('End将最后一项滚入可见区域', lastVisible);
    await page.keyboard.press('Enter');
    check('受限菜单可键盘选择最后一项', await structure.getAttribute('data-value') === 'tree-table');
    await structure.click();
    const reopenedVisible = await list.evaluate((node) => {
      const item = node.querySelector('[aria-selected="true"]');
      const box = node.getBoundingClientRect(); const active = item.getBoundingClientRect();
      return active.top >= box.top + node.clientTop && active.bottom <= box.top + node.clientTop + node.clientHeight;
    });
    check('重新打开受限菜单自动显示选中项', reopenedVisible);
    const freeScroll = await list.evaluate(async (node) => {
      node.scrollTop = 0;
      await new Promise((resolve) => setTimeout(resolve, 100));
      return node.scrollTop === 0;
    });
    check('手动滚动不会被活动项强制拉回', freeScroll);
    await page.keyboard.press('Home');
    check('Home滚回顶部活动项', (await metrics(list)).scrollTop === 0);
    await page.keyboard.press('Escape');
    check('页面无未捕获异常', errors.length === 0, errors.join('\n'));
    return summary();
  } finally { await browser.close(); }
});
