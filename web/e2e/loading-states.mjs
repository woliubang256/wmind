/** 全部加载入口与图片原生事件，使用延迟夹具，不连接后端或写开发数据。 */
import { BASE, check, launchBrowser, newContext, newPage, run, summary } from './lib/harness.mjs';

const user = { uid: 'loading-admin', username: 'loading', email: '', nickname: '', role: 'admin', status: 'active', settings: {} };
const site = { siteName: 'wmind', brand: 'wmind', version: '1.0.0', registrationEnabled: true, passwordMinLength: 8, importEnabled: true, exportEnabled: true, shareEnabled: true, userTemplateEnabled: true };
const image = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120"><rect width="200" height="120" fill="#e8eef8"/></svg>';
const gate = () => { let release; const promise = new Promise((resolve) => { release = resolve; }); return { promise, release }; };

run(async () => {
  const browser = await launchBrowser();
  try {
    for (const path of ['/', '/trash', '/shares', '/account', '/admin', '/admin/users', '/admin/settings', '/templates', '/maps/loading', '/s/loading']) {
      const context = await newContext(browser, { locale: 'zh-CN' });
      const { page, errors } = await newPage(browser, { context });
      const pending = gate();
      await page.route('**/api/v1/**', async (route) => {
        const endpoint = new URL(route.request().url()).pathname.replace('/api/v1', '');
        if (endpoint === '/auth/me') return route.fulfill({ json: { data: user } });
        if (endpoint === '/auth/refresh') return route.fulfill({ json: { data: { accessToken: 'fixture-token', expiresIn: 900, user } } });
        if (endpoint === '/site/config') return route.fulfill({ json: { data: site } });
        await pending.promise;
        await route.fulfill({ json: { data: [], pagination: { total: 0, page: 1, pageSize: 20, totalPages: 1 } } }).catch(() => {});
      });
      await page.goto(`${BASE}${path}`);
      const status = page.locator('main [role="status"]:visible').filter({ has: page.locator('svg.wmind-loading-mark') }).first();
      await status.waitFor();
      check(`${path} 延迟请求显示统一 W 和状态文字`, await status.locator('svg.wmind-loading-mark').isVisible() && (await status.innerText()).trim().length > 0);
      check(`${path} 没有旋转圆圈或闪烁骨架`, await page.locator('.animate-spin, .animate-pulse').count() === 0 && errors.length === 0, errors.join('\n'));
      if (path === '/admin/settings') {
        await page.getByRole('tab', { name: '备份与恢复', exact: true }).click();
        await page.locator('#settings-panel-backup [role="status"] svg.wmind-loading-mark').waitFor();
        check('备份设置使用 W 加载而非空状态图标', await page.locator('#settings-panel-backup [role="status"]').isVisible());
      }
      pending.release();
      await context.close();
    }

    const context = await newContext(browser, { locale: 'zh-CN' });
    const { page, errors } = await newPage(browser, { context });
    await page.route('**/api/v1/**', (route) => {
      const endpoint = new URL(route.request().url()).pathname;
      if (endpoint.endsWith('/auth/refresh')) return route.fulfill({ json: { data: { accessToken: 'fixture-token', expiresIn: 900, user } } });
      return route.fulfill({ json: { data: endpoint.endsWith('/auth/me') ? user : endpoint.endsWith('/site/config') ? site : [], pagination: { total: 0, page: 1, pageSize: 20, totalPages: 1 } } });
    });
    const requests = [];
    const gates = new Map();
    await page.route('**/test-loading/**', async (route) => {
      const key = new URL(route.request().url()).pathname;
      requests.push(key);
      await gates.get(key)?.promise;
      await route.fulfill({ status: key.includes('error') ? 404 : 200, contentType: 'image/svg+xml', body: key.includes('error') ? '' : image }).catch(() => {});
    });
    await page.goto(BASE);
    await page.getByRole('heading', { name: '最近的导图', exact: true }).waitFor();
    await page.evaluate(async () => {
      const { default: React } = await import('/node_modules/.vite/deps/react.js');
      const { default: { createRoot } } = await import('/node_modules/.vite/deps/react-dom_client.js');
      const { LoadingImage, LoadingSvgImage } = await import('/src/components/ui/loading-image.tsx');
      const { LoadingState } = await import('/src/components/ui/loading-state.tsx');
      const { Button } = await import('/src/components/ui/button.tsx');
      const { UserAvatar } = await import('/src/components/user-avatar.tsx');
      document.getElementById('root').hidden = true;
      const container = document.createElement('div'); container.id = 'loading-fixture'; document.body.append(container);
      const root = createRoot(container);
      window.renderLoadingAvatar = (src) => root.render(React.createElement(UserAvatar, { user: { uid: 'loading-avatar', username: 'W', nickname: '', email: '', avatarUrl: src } }));
      window.renderLoadingFixture = (src, loading = true) => root.render(React.createElement('div', { className: 'flex flex-wrap items-center gap-8 p-8' },
        React.createElement(LoadingState, { label: '正在加载…' }),
        React.createElement('div', { id: 'html-image' }, React.createElement(LoadingImage, { src, alt: '导图图片', width: 200, height: 120, loading: 'lazy', containerClassName: 'h-[120px] w-[200px] border border-border', className: 'size-full object-contain' })),
        React.createElement('svg', { id: 'svg-image', width: 200, height: 120, viewBox: '0 0 200 120' }, React.createElement(LoadingSvgImage, { href: src, x: 20, y: 20, width: 160, height: 80, loading: true })),
        React.createElement(Button, { loading, id: 'loading-button' }, '保存')));
    });
    const a = gate(), b = gate(); gates.set('/test-loading/a.svg', a); gates.set('/test-loading/b.svg', b);
    await page.evaluate(() => window.renderLoadingFixture('/test-loading/a.svg'));
    await page.locator('#html-image .wmind-loading-mark').waitFor();
    await page.locator('#svg-image .wmind-loading-mark').waitFor();
    check('HTML 与 SVG 图片均显示浅灰 W 且不改变图片尺寸', await page.locator('#html-image img').getAttribute('loading') === 'lazy' && (await page.locator('#html-image').boundingBox()).width === 200 && await page.locator('#svg-image image').getAttribute('width') === '160');
    const svgMark = await page.locator('#svg-image .wmind-loading-mark').evaluate((node) => {
      const paths = [...node.querySelectorAll(':scope > path')].map((path) => path.getBoundingClientRect());
      return { width: Math.max(...paths.map((box) => box.right)) - Math.min(...paths.map((box) => box.left)), css: getComputedStyle(node).width, style: node.getAttribute('style') };
    });
    check('画布图片 W 实际图形不超过指定的局部尺寸', svgMark.width <= 40, JSON.stringify(svgMark));
    for (const theme of ['light', 'dark']) {
      await page.evaluate((value) => document.documentElement.classList.toggle('dark', value === 'dark'), theme);
      const [normal, soft] = await page.evaluate(() => ['[role="status"] .wmind-loading-mark', '#html-image .wmind-loading-mark'].map((selector) => getComputedStyle(document.querySelector('#loading-fixture ' + selector)).getPropertyValue('--loading-mark-face').trim()));
      const brightness = (hex) => hex.replace('#', '').match(/../g).reduce((sum, value) => sum + parseInt(value, 16), 0);
      check(`${theme} 图片 W 比标准 W 更浅`, brightness(soft) > brightness(normal));
      await page.setViewportSize({ width: 375, height: 900 });
      await page.screenshot({ path: `/tmp/wmind-unified-loading-${theme}.png` });
      check(`${theme} 窄屏没有横向溢出`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
    check('加载按钮保留可访问名称和禁用状态', await page.getByRole('button', { name: '保存', exact: true }).isDisabled() && await page.locator('#loading-button').getAttribute('aria-busy') === 'true');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    check('所有 W 遵守减少动画设置', await page.locator('#loading-fixture .wmind-loading-mark__shine').evaluateAll((nodes) => nodes.every((node) => getComputedStyle(node).animationName === 'none')));
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.evaluate(() => window.renderLoadingFixture('/test-loading/b.svg'));
    a.release();
    await page.waitForFunction(() => [...document.querySelectorAll('#html-image img, #svg-image image')].every((node) => (node.getAttribute('src') ?? node.getAttribute('href')).includes('b.svg')));
    check('切换地址后旧图片完成不会移除新图片的占位', await page.locator('#html-image .wmind-loading-mark').count() === 1 && await page.locator('#svg-image .wmind-loading-mark').count() === 1);
    b.release();
    await page.locator('#html-image .wmind-loading-mark').waitFor({ state: 'hidden' });
    await page.locator('#svg-image .wmind-loading-mark').waitFor({ state: 'hidden' });
    check('加载成功后两类图片均结束动画并显示图片', await page.locator('#html-image img').evaluate((node) => node.complete && node.naturalWidth > 0 && getComputedStyle(node).opacity === '1') && await page.locator('#svg-image image').getAttribute('opacity') === null);
    await page.evaluate(() => window.renderLoadingFixture('/test-loading/error.svg', false));
    await page.locator('#html-image .wmind-loading-mark').waitFor({ state: 'hidden' });
    await page.locator('#svg-image .wmind-loading-mark').waitFor({ state: 'hidden' });
    check('图片失败停止动画，按钮恢复后没有残留 W', await page.locator('#loading-button .wmind-loading-mark').count() === 0 && !await page.locator('#loading-button').isDisabled());
    await page.evaluate((body) => window.renderLoadingFixture(`data:image/svg+xml,${encodeURIComponent(body)}`, false), image);
    await page.locator('#html-image .wmind-loading-mark').waitFor({ state: 'hidden' });
    await page.locator('#svg-image .wmind-loading-mark').waitFor({ state: 'hidden' });
    check('缓存可用的内嵌图片不会停留在加载态', await page.locator('#html-image img').evaluate((node) => node.complete && node.naturalWidth === 200));
    check('每个原生图片元素没有额外的预取请求', requests.filter((url) => url.includes('b.svg')).length <= 2 && requests.filter((url) => url.includes('error.svg')).length <= 2);
    const avatar = gate(); gates.set('/test-loading/avatar.svg', avatar);
    await page.evaluate(() => window.renderLoadingAvatar('/test-loading/avatar.svg'));
    await page.locator('#loading-fixture [data-user-avatar] .wmind-loading-mark').waitFor();
    const avatarBox = await page.locator('#loading-fixture [data-user-avatar] .wmind-loading-mark').boundingBox();
    check('小头像加载保持圆形尺寸，浅灰 W 不溢出', avatarBox.width <= 20 && (await page.locator('#loading-fixture [data-user-avatar]').boundingBox()).width === 32);
    avatar.release();
    await page.locator('#loading-fixture [data-user-avatar] .wmind-loading-mark').waitFor({ state: 'hidden' });
    check('头像成功后显示原图', await page.locator('#loading-fixture [data-user-avatar] img').evaluate((node) => node.complete && node.naturalWidth > 0));
    await page.evaluate(() => window.renderLoadingAvatar('/test-loading/avatar-error.svg'));
    await page.locator('#loading-fixture [data-user-avatar] img').waitFor({ state: 'detached' });
    check('头像加载失败仍回退首字符，不留下扫光', await page.locator('#loading-fixture [data-user-avatar]').innerText() === 'W' && await page.locator('#loading-fixture [data-user-avatar] .wmind-loading-mark').count() === 0);
    check('图片与按钮状态切换没有渲染异常', errors.length === 0, errors.join('\n'));
    await context.close();
    return summary();
  } finally { await browser.close(); }
});
