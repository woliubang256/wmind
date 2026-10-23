import { BASE, check, launchBrowser, newPage, run, summary } from './lib/harness.mjs';

// 独立接口夹具：只验布局和交互，不向开发数据库写入账号或撤销真实分享。
run(async () => {
  const browser = await launchBrowser();
  try {
    const { page, errors } = await newPage(browser);
    const user = { uid: 'cleanup-admin', username: 'admin', nickname: '管理员', email: '', role: 'admin', status: 'active' };
    const share = { uid: 'cleanup-share', mapUid: 'map', mapTitle: '布局测试', url: '/s/cleanup', createdAt: new Date().toISOString(), viewCount: 0, allowDownload: true };
    let revoked = false;
    await page.route('**/api/v1/**', async (route) => {
      const path = new URL(route.request().url()).pathname.replace('/api/v1', '');
      if (path.startsWith('/admin/backup')) return route.fulfill({ status: 503, json: { error: { code: 'INTERNAL_ERROR', message: '界面夹具不启用备份' } } });
      let data = [];
      if (path === '/auth/me') data = user;
      if (path === '/site/config') data = { siteName: 'wmind', passwordMinLength: 8, shareEnabled: true };
      if (path === '/auth/2fa/status') data = { enabled: false };
      if (path === '/shares') data = [{ ...share, revokedAt: revoked ? new Date().toISOString() : null }];
      if (path === '/shares/cleanup-share' && route.request().method() === 'DELETE') {
        revoked = true;
        return route.fulfill({ status: 204 });
      }
      if (path === '/admin/stats') data = { userCount: 1, activeUserCount: 1, mapCount: 2, mapCountToday: 1, storageUsedBytes: 1024, trend: [{ date: '2026-10-23', newUsers: 0, newMaps: 0 }, { date: '2026-10-24', newUsers: 1, newMaps: 1 }] };
      if (path === '/admin/settings') data = {};
      await route.fulfill({ json: { data, pagination: { page: 1, pageSize: 20, total: Array.isArray(data) ? data.length : 0, totalPages: 1 } } });
    });
    await page.goto(`${BASE}/account`);
    await page.getByRole('heading', { name: '个人设置', exact: true }).waitFor();
    check('个人设置不再重复外观和语言面板', await page.getByRole('radiogroup').count() === 0 && await page.locator('main').getByRole('heading', { name: '外观', exact: true }).count() === 0);
    check('个人设置删除说明并将大小限制放在格式旁', !await page.getByText('管理你的账号信息、密码与界面外观。').count() && !await page.getByText(/会居中裁切/).count() && /PNG.*JPEG.*WebP.*2\s?MB/.test(await page.locator('main').innerText()));
    const locale = page.locator('header').getByRole('combobox');
    const username = page.getByRole('button', { name: '用户菜单', exact: true });
    const font = await locale.evaluate((node) => getComputedStyle(node).fontSize);
    check('语言入口与用户名均为14px', font === '14px' && await username.evaluate((node) => getComputedStyle(node).fontSize) === font, font);
    await locale.click();
    check('语言选项字号为14px', await page.getByRole('option').first().evaluate((node) => getComputedStyle(node).fontSize) === '14px');
    await page.getByRole('option', { name: 'English', exact: true }).click();
    await page.getByRole('heading', { name: 'Account', exact: true }).waitFor();
    await page.reload();
    await page.getByRole('heading', { name: 'Account', exact: true }).waitFor();
    check('右上角语言切换和刷新保持正常', await locale.getAttribute('data-value') === 'en-US');
    await locale.click();
    await page.getByRole('option', { name: '中文', exact: true }).click();
    await page.getByRole('button', { name: '切换外观', exact: true }).click();
    const theme = await page.evaluate(() => localStorage.getItem('wmind:theme'));
    await page.reload();
    await page.getByRole('heading', { name: '个人设置', exact: true }).waitFor();
    check('右上角外观切换和刷新保持正常', await page.evaluate(() => localStorage.getItem('wmind:theme')) === theme);

    for (const [path, title, removed] of [
      ['/shares', '我的分享', '这里能看到你发出去的所有链接，随时收回。'],
      ['/trash', '回收站', '删掉的导图会先放在这里，可以恢复或彻底删除。'],
      ['/admin', '管理概览', '站点规模与最近的管理操作。'],
      ['/admin/users', '用户管理', '创建、编辑、禁用账号，或为忘记密码的用户重置密码。'],
      ['/admin/settings', '网站设置', '改动保存后立即生效，无需重启服务。'],
    ]) {
      await page.goto(`${BASE}${path}`);
      await page.getByRole('heading', { name: title, exact: true }).waitFor();
      check(`${title}删除圈出的说明`, !(await page.locator('main').innerText()).includes(removed));
      if (path === '/admin') {
        check('最近操作删除说明', !await page.getByText('审计日志只增不改，记录谁在什么时候改了什么。').count());
        const zeroBar = page.locator('main section').first().locator('.group').first();
        check('零新增不显示虚假的柱条', await zeroBar.locator('span').evaluateAll((nodes) => nodes.length === 2 && nodes.every((node) => parseFloat(getComputedStyle(node).height) === 0)));
      }
      if (path === '/admin/users') {
        await page.getByRole('button', { name: '新建用户', exact: true }).click();
        const formDialog = page.getByRole('dialog', { name: '新建用户', exact: true });
        await formDialog.waitFor();
        check('有正文的表单弹窗保留正文和分隔', await formDialog.evaluate((node) => node.children.length === 3 && getComputedStyle(node.children[0]).borderBottomWidth === '1px' && getComputedStyle(node.children[2]).borderTopWidth === '1px'));
        await page.keyboard.press('Escape');
      }
      if (path === '/admin/settings') check('网站设置保留影响提示', await page.getByText('部分设置会影响已登录用户，请留意提示。', { exact: true }).count() === 1);
    }

    await page.goto(`${BASE}/shares`);
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '撤销这条分享链接？', exact: true });
    await dialog.waitFor();
    const geometry = await dialog.evaluate((node) => {
      const sections = [...node.children];
      return { count: sections.length, separators: sections.reduce((n, child) => n + (parseFloat(getComputedStyle(child).borderTopWidth) > 0 ? 1 : 0) + (parseFloat(getComputedStyle(child).borderBottomWidth) > 0 ? 1 : 0), 0) };
    });
    check('纯确认弹窗无空正文且仅一条分隔线', geometry.count === 2 && geometry.separators === 1, JSON.stringify(geometry));
    await page.keyboard.press('Escape');
    check('Esc关闭确认弹窗', !await dialog.isVisible());
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    check('取消不撤销分享', !revoked && !await dialog.isVisible());
    await page.setViewportSize({ width: 375, height: 812 });
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    const box = await dialog.boundingBox();
    check('窄屏弹窗不溢出', box.x >= 0 && box.x + box.width <= 375);
    await dialog.getByRole('button', { name: '撤销', exact: true }).click();
    await page.getByText('已撤销', { exact: true }).waitFor();
    check('确认仍执行撤销并关闭弹窗', revoked && !await dialog.isVisible());
    check('页面无未捕获异常', errors.length === 0, errors.join('\n'));
    return summary();
  } finally {
    await browser.close();
  }
});
