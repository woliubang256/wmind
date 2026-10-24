/** Full-site restoration is destructive. Run only against an isolated backend. */
import http from 'node:http';
import { once } from 'node:events';
import { BASE, API, ADMIN, api, check, launchBrowser, login, newPage, run, summary, uiLogin } from './lib/harness.mjs';

run(async () => {
  if (process.env.WMIND_BACKUP_E2E_ISOLATED !== '1') throw new Error('Set WMIND_BACKUP_E2E_ISOLATED=1 only for a disposable backend/database/uploads directory.');
  let archive;
  const objects = new Map();
  const dav = http.createServer(async (req, res) => {
    const authorization = `Basic ${Buffer.from('backup-user:backup-password').toString('base64')}`;
    if (req.headers.authorization !== authorization) { res.writeHead(401); res.end(); return; }
    if (req.method === 'PROPFIND') { res.writeHead(207); res.end(); return; }
    if (req.method === 'HEAD') { res.writeHead(objects.has(req.url) ? 200 : 404); res.end(); return; }
    if (req.method === 'PUT') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      if (req.url.endsWith('.zip')) { archive = Buffer.concat(chunks); objects.set(req.url, archive); }
      res.writeHead(201); res.end(); return;
    }
    if (req.method === 'DELETE') { objects.delete(req.url); res.writeHead(204); res.end(); return; }
    res.writeHead(405); res.end();
  });
  dav.listen(0, '127.0.0.1'); await once(dav, 'listening');
  const browser = await launchBrowser();
  try {
    const token = await login(ADMIN.email, ADMIN.password);
    // Permit rerunning against the same explicitly disposable instance.
    const baseline = await api('/admin/backups', { token });
    if (baseline.data.history.length) {
      await api('/admin/backups/config', { method: 'PUT', token, body: { ...baseline.data.configuration, enabled: false, cron: '0 3 * * *', timezone: 'Asia/Shanghai', target: 'webdav' } });
      await api('/admin/settings', { method: 'PUT', token, body: { 'site.name': 'wmind' } });
    }
    const { page, errors } = await newPage(browser);
    await uiLogin(page, { email: ADMIN.email, password: ADMIN.password });
    await page.goto(`${BASE}/admin/settings`);
    const tab = page.getByRole('tab', { name: '备份与恢复', exact: true });
    await tab.click();
    const panel = page.getByRole('tabpanel', { name: '备份与恢复', exact: true });
    await panel.getByRole('switch', { name: '启用定时备份' }).waitFor();
    check('关闭状态与独立恢复区域正确显示', await panel.getByRole('switch', { name: '启用定时备份' }).getAttribute('aria-checked') === 'false' && await panel.getByLabel('选择备份 ZIP').isVisible());
    const retention = panel.getByLabel('保留份数', { exact: true });
    const dedup = panel.getByRole('switch', { name: '仅在数据变化时备份', exact: true });
    check('默认保留 30 份且去重关闭', await retention.inputValue() === '30' && await dedup.getAttribute('aria-checked') === 'false');
    await retention.fill('0');
    check('无效保留份数禁止保存', await panel.getByRole('button', { name: '保存备份配置', exact: true }).isDisabled());
    await retention.fill('2');
    await panel.getByRole('switch', { name: '启用定时备份' }).click();
    await panel.getByRole('switch', { name: '启用定时备份' }).locator('span').evaluate(async (node) => { await Promise.all(node.getAnimations().map((animation) => animation.finished)); });
    const switchTrack = await panel.getByRole('switch', { name: '启用定时备份' }).boundingBox();
    const switchKnob = await panel.getByRole('switch', { name: '启用定时备份' }).locator('span').boundingBox();
    check('开关圆点始终位于轨道内', switchKnob.x >= switchTrack.x && switchKnob.x + switchKnob.width <= switchTrack.x + switchTrack.width);

    const pick = async (name, option) => { await panel.getByRole('combobox', { name, exact: true }).click(); await page.getByRole('option', { name: option, exact: true }).click(); };
    const expression = panel.getByLabel('Cron 表达式', { exact: true });
    await pick('备份频率', '每周一凌晨 03:00');
    check('预设频率不展开高级 Cron 控件', await expression.count() === 0);
    await pick('备份频率', '自定义');
    check('预设生成标准五段表达式', await expression.inputValue() === '0 3 * * 1');
    await pick('分钟规则', '按间隔');
    await panel.getByLabel('分钟间隔', { exact: true }).fill('15');
    check('可视化间隔同步到原始表达式', await expression.inputValue() === '*/15 3 * * 1');
    await expression.fill('10 4 * * 1,3');
    const weekday = panel.getByRole('group', { name: '星期', exact: true });
    await weekday.locator('summary').click();
    check('原始表达式反向同步到多选规则', await weekday.getByRole('button', { name: '星期 周一', exact: true }).getAttribute('aria-pressed') === 'true' && await weekday.getByRole('button', { name: '星期 周三', exact: true }).getAttribute('aria-pressed') === 'true');
    await weekday.getByRole('button', { name: '星期 周五', exact: true }).click();
    check('星期多选保留其他四段', await expression.inputValue() === '10 4 * * 1,3,5');
    await expression.fill('* * * * * *');
    await panel.getByText('Cron 表达式或时区无效，或没有可执行的日期。').waitFor();
    check('无效 Cron 显示错误并禁止保存', await panel.getByRole('button', { name: '保存备份配置', exact: true }).isDisabled());
    await pick('备份频率', '每天凌晨 03:00');
    await panel.getByLabel('执行时区', { exact: true }).fill('UTC');
    await pick('备份方式', 'S3 / 兼容存储');
    check('S3 条件表单和 Path Style 显示', await panel.getByLabel('S3 Endpoint', { exact: true }).isVisible() && await panel.getByRole('switch', { name: '使用 Path Style 地址' }).getAttribute('aria-checked') === 'true');
    await pick('备份方式', 'WebDAV');
    await panel.getByLabel('WebDAV 目录地址', { exact: true }).fill(`http://127.0.0.1:${dav.address().port}/backups`);
    await panel.getByLabel('WebDAV 用户名', { exact: true }).fill('backup-user');
    await panel.getByLabel('WebDAV 密码', { exact: true }).fill('backup-password');
    await panel.getByRole('button', { name: '测试连接', exact: true }).click();
    await page.getByText('连接测试通过', { exact: true }).waitFor();
    check('未保存的配置可以测试连接', true);
    await panel.getByRole('button', { name: '保存备份配置', exact: true }).click();
    await page.getByText('备份配置已保存', { exact: true }).waitFor();
    check('保存后密码清空并保留已设置标记', await panel.getByLabel('WebDAV 密码', { exact: true }).inputValue() === '' && await panel.getByLabel('WebDAV 密码', { exact: true }).getAttribute('placeholder') === '••••••••');
    const stored = await api('/admin/backups', { token });
    check('API 不回传远端密码，显示五次执行时间', !JSON.stringify(stored).includes('backup-password') && stored.data.nextRuns.length === 5 && stored.data.configuration.timezone === 'UTC');
    check('保留份数与关闭的去重状态正确保存', stored.data.configuration.retainCount === 2 && stored.data.configuration.skipUnchanged === false);
    await page.setViewportSize({ width: 375, height: 812 });
    check('窄屏表单不产生横向溢出', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: '/tmp/wmind-backup-mobile.png', fullPage: true });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({ path: '/tmp/wmind-backup-desktop.png', fullPage: true });
    // An English context uses the same saved server configuration.
    const english = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 900 } });
    const englishPage = await english.newPage();
    await englishPage.goto(`${BASE}/login`);
    await englishPage.getByLabel('Username or email', { exact: true }).fill(ADMIN.email);
    await englishPage.getByLabel('Password', { exact: true }).fill(ADMIN.password);
    await englishPage.getByRole('button', { name: 'Sign in', exact: true }).click();
    await englishPage.waitForURL((url) => !url.pathname.startsWith('/login'));
    await englishPage.goto(`${BASE}/admin/settings`);
    await englishPage.getByRole('tab', { name: 'Backup & restore', exact: true }).click();
    const englishPanel = englishPage.getByRole('tabpanel', { name: 'Backup & restore', exact: true });
    await englishPanel.getByLabel('WebDAV directory URL', { exact: true }).waitFor();
    check('英文备份页没有遗漏的中文', !/[\u4e00-\u9fff]/.test(await englishPanel.innerText()));
    await englishPage.close(); await english.close();
    const launchResponse = page.waitForResponse((response) => response.url().endsWith('/admin/backups/run') && response.status() === 201);
    await panel.getByRole('button', { name: '立即备份', exact: true }).click();
    const launched = (await (await launchResponse).json()).data;
    let completed;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const current = (await api('/admin/backups', { token })).data.current;
      if (current?.id === launched.id && current.status === 'succeeded') { completed = current; break; }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!completed) throw new Error('The newly launched backup did not finish.');
    await panel.getByText(completed.filename, { exact: true }).locator('..').getByText('已完成', { exact: true }).waitFor({ timeout: 30000 });
    check('立即备份上传真实 ZIP 并显示完成结果', archive?.subarray(0, 2).toString() === 'PK');
    const repeatBackup = async () => {
      const { data: job } = await api('/admin/backups/run', { method: 'POST', token });
      const end = Date.now() + 30000;
      while (Date.now() < end) {
        const current = (await api('/admin/backups', { token })).data.current;
        if (current?.id === job.id && current.status !== 'running') return current;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error('Backup job timed out');
    };
    const repeated = await repeatBackup();
    check('去重关闭时相同版本仍生成新完整备份', repeated.status === 'succeeded' && repeated.contentVersion === completed.contentVersion && repeated.filename !== completed.filename && objects.size === 2);
    const restoreArchive = Buffer.from(archive);
    await dedup.click();
    await panel.getByRole('button', { name: '保存备份配置', exact: true }).click();
    await page.getByText('备份配置已保存', { exact: true }).waitFor();
    check('去重开关可开启并持久保存', (await api('/admin/backups', { token })).data.configuration.skipUnchanged === true);
    const skipped = await repeatBackup();
    check('开启后无变化跳过且不增加对象', skipped.status === 'skipped' && skipped.bytes === undefined && objects.size === 2);
    await panel.getByText('数据未变化，已跳过', { exact: true }).first().waitFor({ timeout: 30000 });
    check('界面显示跳过原因与内容版本', await panel.getByText(`内容版本：${skipped.contentVersion}`, { exact: true }).first().isVisible());
    await login(ADMIN.email, ADMIN.password);
    await api('/maps', { token });
    check('真实登录及浏览后仍跳过', (await repeatBackup()).status === 'skipped');
    await api('/admin/settings', { method: 'PUT', token, body: { 'site.name': 'After backup' } });
    const changed = await repeatBackup();
    check('真实配置变化生成备份并清理超额旧副本', changed.status === 'succeeded' && changed.contentVersion !== skipped.contentVersion && objects.size === 2 && !objects.has(`/backups/${completed.filename}`));
    await panel.getByLabel('选择备份 ZIP', { exact: true }).setInputFiles({ name: 'invalid.zip', mimeType: 'application/zip', buffer: Buffer.from('invalid archive') });
    await panel.getByRole('alert').filter({ hasText: '备份包损坏' }).waitFor();
    check('损坏 ZIP 显示校验失败，不打开覆盖确认', await page.getByRole('dialog', { name: '确认恢复备份', exact: true }).count() === 0 || !await page.getByRole('dialog', { name: '确认恢复备份', exact: true }).isVisible());
    await panel.getByLabel('选择备份 ZIP', { exact: true }).setInputFiles({ name: 'backup.zip', mimeType: 'application/zip', buffer: restoreArchive });
    const dialog = page.getByRole('dialog', { name: '确认恢复备份', exact: true });
    await dialog.waitFor();
    check('手动上传校验后展示清单，必须确认覆盖', await dialog.getByText('backup.zip', { exact: true }).isVisible() && await dialog.getByRole('button', { name: '确认覆盖并恢复' }).isDisabled());
    await dialog.getByRole('checkbox').check();
    await dialog.getByRole('button', { name: '确认覆盖并恢复' }).click();
    await page.waitForURL('**/login', { timeout: 30000 });
    check('恢复完成后旧会话退出', page.url().endsWith('/login'));
    const site = await api('/site/config');
    check('恢复还原备份中的站点设置', site.data.siteName === 'wmind');
    const renewed = await login(ADMIN.email, ADMIN.password);
    const restored = await api('/admin/backups', { token: renewed });
    check('重新登录可见恢复结果与本地安全副本', restored.data.history[0]?.kind === 'restore' && restored.data.history[0]?.status === 'succeeded' && Boolean(restored.data.history[0]?.recoveryFile));
    check('备份界面没有浏览器异常', errors.length === 0, errors.join('\n'));
    if (!summary()) process.exitCode = 1;
  } finally { await browser.close(); await new Promise((resolve) => dav.close(resolve)); }
});
