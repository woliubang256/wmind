/**
 * M6 验收：错误处理（断网提示 + 崩溃兜底页）。
 *
 * 崩溃兜底页没法从外部触发——它只在渲染期抛错时出现。所以这一条用**临时注入**
 * 的办法验：把 `RecentPage` 改成一进函数就 throw，跑完再 `git checkout` 回来。
 * 注入的那一行不在任何提交里，验完即恢复。
 */

import { BASE, api, check, ensureUser, launchBrowser, makeUser, newContext, newPage, run, summary, uiLogin } from './lib/harness.mjs';

/** `--crash` 只在注入了崩溃的那一轮用，见文件头。 */
const CRASH = process.argv.includes('--crash');

const USER = makeUser('err');

async function main() {
  await ensureUser(USER);

  const browser = await launchBrowser({ width: 1280, height: 860 });
  const { page, errors, context } = await newPage(browser);
  const consoleErrors = [];
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });

  try {
    await uiLogin(page, USER);

    if (CRASH) {
      // ── 崩溃兜底页 ─────────────────────────────────────────────────────
      await page.goto(`${BASE}/`);
      const heading = await page.getByRole('heading', { name: '页面出错了' }).textContent({ timeout: 15000 });
      check('IE-M6-04 渲染期抛错时显示崩溃兜底页而不是白屏', heading === '页面出错了');

      const reload = await page.getByRole('button', { name: '刷新页面' }).count();
      const home = await page.getByRole('button', { name: '返回首页' }).count();
      check('IE-M6-05 兜底页有「刷新页面」与「返回首页」两个出口', reload === 1 && home === 1);

      const details = await page.evaluate(() => {
        const node = document.querySelector('details summary');
        return node === null ? null : node.textContent ?? '';
      });
      const message = await page.evaluate(() => {
        const details = document.querySelector('details');
        return details === null ? null : details.textContent ?? '';
      });
      check(
        'IE-M6-06 兜底页给出错误编号与原始消息',
        /编号 [0-9a-z]{8}/.test(details ?? '') && (message ?? '').includes('injected-for-acceptance'),
        `${details} / ${(message ?? '').slice(0, 60)}`,
      );

      // 错误被边界**接住**了，所以不会有未捕获的 pageerror——它应该出现在
      // console.error 里（带着同一个编号），供用户报障时对照。
      const consoleLogged = consoleErrors.some((text) => text.includes('injected-for-acceptance'));
      const withIncident = consoleErrors.some((text) => text.includes('渲染错误 #'));
      check(
        'IE-M6-07 崩溃同时打进控制台，并带上同一个编号',
        consoleLogged && withIncident,
        consoleErrors.slice(0, 2).join(' | ').slice(0, 160),
      );
    } else {
      // ── 断网提示 ───────────────────────────────────────────────────────
      await page.getByRole('button', { name: '新建导图' }).waitFor({ timeout: 30000 });
      const before = await page.evaluate(() => document.querySelectorAll('[role="status"]').length);

      await context.setOffline(true);
      await page.waitForTimeout(600);
      const offlineText = await page.evaluate(() => {
        const nodes = Array.from(document.querySelectorAll('[role="status"]'));
        const hit = nodes.find((node) => (node.textContent ?? '').includes('网络已断开'));
        return hit === undefined ? null : hit.textContent;
      });
      check('IE-M6-01 断网时出现提示条', (offlineText ?? '').includes('网络已断开'), offlineText ?? `status 节点 ${before}`);

      await context.setOffline(false);
      await page.waitForTimeout(600);
      const afterOnline = await page.evaluate(() =>
        Array.from(document.querySelectorAll('[role="status"]')).some((node) =>
          (node.textContent ?? '').includes('网络已断开'),
        ),
      );
      check('IE-M6-02 恢复连接后提示条自动消失', afterOnline === false);

      // 断网时**新开**的页面：把 navigator.onLine 钉成 false 再加载（真断网时
      // SPA 本身都下载不下来，那不是这条要验的东西）。验的是首帧快照——
      // 用 useSyncExternalStore 才有的性质，用 useEffect 订阅会先渲染成「在线」。
      const offlineContext = await newContext(browser);
      await offlineContext.addInitScript(() => {
        Object.defineProperty(Navigator.prototype, 'onLine', { get: () => false });
      });
      const offlinePage = await offlineContext.newPage();
      await offlinePage.goto(`${BASE}/trash`);
      const firstFrame = await offlinePage.evaluate(() =>
        Array.from(document.querySelectorAll('[role="status"]')).some((node) =>
          (node.textContent ?? '').includes('网络已断开'),
        ),
      );
      check('IE-M6-03 一开始就不在线时，首帧就带提示条（不靠事件）', firstFrame === true);
      await offlineContext.close();
      await context.setOffline(false);
    }
  } finally {
    await browser.close();
  }

  return summary();
}

run(main);
