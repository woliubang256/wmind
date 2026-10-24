/** 整页加载状态：延迟模拟认证，不访问后端或修改开发数据。 */
import assert from 'node:assert/strict';
import { BASE, check, launchBrowser, newContext, newPage, run, summary } from './lib/harness.mjs';

run(async () => {
  const browser = await launchBrowser();
  try {
    for (const locale of ['zh-CN', 'en-US']) {
      const context = await newContext(browser, { locale });
      await context.addInitScript(() => localStorage.setItem('wmind:theme', 'light'));
      const { page, errors } = await newPage(browser, { context });
      let releaseAuth;
      const auth = new Promise((resolve) => { releaseAuth = resolve; });
      await page.route('**/api/v1/**', async (route) => {
        const path = new URL(route.request().url()).pathname.replace('/api/v1', '');
        if (path === '/auth/me') {
          await auth;
          return route.fulfill({ json: { data: { uid: 'loading-user', username: 'loading', email: 'loading@example.test', nickname: '', role: 'user', status: 'active', settings: {} } } });
        }
        await route.fulfill({ json: { data: path === '/site/config' ? { siteName: 'wmind', brand: 'wmind', version: '1.0.0', importEnabled: true, exportEnabled: true, shareEnabled: true, userTemplateEnabled: true } : [], pagination: { total: 0, page: 1, pageSize: 20, totalPages: 1 } } });
      });
      await page.goto(BASE);
      const label = locale === 'zh-CN' ? '正在加载…' : 'Loading…';
      const status = page.getByRole('status').filter({ hasText: label });
      const logo = status.locator('svg.wmind-loading-mark');
      await logo.waitFor();
      check(`${locale} 仅保留原有加载文字且标志不重复朗读`, await status.innerText() === label && await logo.getAttribute('aria-hidden') === 'true' && await logo.getAttribute('focusable') === 'false');
      for (const theme of ['light', 'dark']) {
        await page.evaluate((value) => document.documentElement.classList.toggle('dark', value === 'dark'), theme);
        for (const width of [375, 1440]) {
          await page.setViewportSize({ width, height: 900 });
          const mark = await logo.boundingBox();
          const text = await status.locator('p').boundingBox();
          const group = await status.boundingBox();
          check(`${locale} ${theme} ${width}px标志在文字上方且整体居中`, Math.abs(mark.width - 72) < 1 && Math.abs(text.y - mark.y - mark.height - 16) < 1 && Math.abs(group.x + group.width / 2 - width / 2) < 1 && Math.abs(group.y + group.height / 2 - 450) < 1 && await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        }
        const colors = await logo.evaluate((node) => {
          const css = getComputedStyle(node);
          return ['edge', 'face', 'fold'].map((part) => css.getPropertyValue(`--loading-mark-${part}`).trim());
        });
        check(`${locale} ${theme} 折面层次与主题配色有效`, new Set(colors).size === 3 && colors.includes(theme === 'light' ? '#aeb6c2' : '#657183'));
        const sweep = logo.locator('.wmind-loading-mark__shine');
        check(`${locale} ${theme} 亮带周期扫过而非标志闪烁`, await sweep.evaluate((node) => getComputedStyle(node).animationDuration === '2.4s' && getComputedStyle(node).animationIterationCount === 'infinite') && await logo.evaluate((node) => getComputedStyle(node).opacity === '1'));
        await sweep.evaluate((node) => {
          const animation = node.getAnimations()[0];
          animation.pause();
          animation.currentTime = 0;
        });
        const before = await logo.screenshot();
        await sweep.evaluate((node) => { node.getAnimations()[0].currentTime = 960; });
        const after = await logo.screenshot();
        check(`${locale} ${theme} 扫光确实改变W像素`, !before.equals(after));
        await page.setViewportSize({ width: 375, height: 900 });
        await page.screenshot({ path: `/tmp/wmind-loading-${locale}-${theme}.png` });
        await page.emulateMedia({ reducedMotion: 'reduce' });
        check(`${locale} ${theme} 减少动态效果时保留静态W`, await sweep.evaluate((node) => getComputedStyle(node).animationName === 'none' && getComputedStyle(node).opacity === '0') && await logo.isVisible());
        const still = await logo.screenshot();
        const stillAgain = await logo.screenshot();
        assert.deepEqual(still, stillAgain);
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        check(`${locale} ${theme} 关闭减少动态效果后恢复扫光`, await sweep.evaluate((node) => getComputedStyle(node).animationName === 'wmind-loading-sweep' && getComputedStyle(node).opacity === '1'));
      }
      releaseAuth();
      await logo.waitFor({ state: 'hidden' });
      await page.getByRole('heading', { name: locale === 'zh-CN' ? '最近的导图' : 'Recent maps', exact: true }).waitFor();
      check(`${locale} 加载完成正常进入页面且没有残留动效`, await page.locator('svg.wmind-loading-mark').count() === 0 && errors.length === 0, errors.join('\n'));
      await context.close();
    }
    return summary();
  } finally { await browser.close(); }
});
