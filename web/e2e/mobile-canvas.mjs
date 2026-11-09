/** Native touch/pointer regression with page-local API fixtures; never reads development data. */
import assert from 'node:assert/strict';
import os from 'node:os';
import { chromium } from 'playwright-core';

const BASE = process.env.BASE ?? 'http://127.0.0.1:5283';
const CHROME = process.env.PLAYWRIGHT_CHROMIUM ?? `${os.homedir()}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const now = '2026-10-26T00:00:00Z';
const topic = (id, title, children = []) => ({
  id, title, titleFormat: 'plain', structure: null, style: null, collapsed: false,
  href: '', notes: { plain: '', html: '' }, labels: [], markers: [], image: null,
  children: { attached: children, detached: [] }, summaries: [], boundaries: [], extensions: [],
});
const sourceDocument = {
  format: 'wmind', formatVersion: '1.0', id: 'mobile-doc', title: '移动画布验收',
  sheets: [{
    id: 'mobile-sheet', title: '画布 1', structure: 'mindmap',
    rootTopic: topic('mobile-root', '中心主题', [
      { ...topic('mobile-a', '分支 A', [topic('mobile-a1', '子主题 A1')]), content: { todo: false } },
      topic('mobile-b', '分支 B', [topic('mobile-b1', '子主题 B1')]),
    ]),
    floatingTopics: [], relationships: [], boundaries: [], summaries: [], themeOverride: null, extensions: [],
  }],
  meta: { createdAt: now, updatedAt: now, app: 'wmind/1.0.0' }, extensions: [],
};
let passed = 0;
const failures = [];
function check(name, condition) {
  assert.ok(condition, name);
  passed += 1;
  console.log(`[PASS] ${name}`);
}
const closeTo = (value, expected, tolerance = 2) => Math.abs(value - expected) <= tolerance;
const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox', '--font-render-hinting=none'] });

async function fixture({ mobile = true, share = false, relationship = false, secondSheet = false } = {}) {
  const context = await browser.newContext({ viewport: { width: mobile ? 375 : 1440, height: 1000 }, locale: 'zh-CN', hasTouch: true, isMobile: mobile });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const cdp = await context.newCDPSession(page);
  const errors = [];
  const writes = [];
  const mutations = [];
  let saved = structuredClone(sourceDocument);
  if (relationship) saved.sheets[0].relationships = [{ id: 'mobile-relation', end1Id: 'mobile-a', end2Id: 'mobile-b', title: '关联', style: { lineStyle: 'curve' } }];
  if (secondSheet) saved.sheets.push({ ...structuredClone(saved.sheets[0]), id: 'mobile-second', title: '画布 2', rootTopic: topic('mobile-second-root', '第二画布', [topic('mobile-second-a', '第二分支')]) });
  let version = 1;
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace('/api/v1', '');
    if (!['GET', 'HEAD'].includes(request.method()) && path !== '/auth/refresh') mutations.push({ method: request.method(), path });
    const user = { uid: 'mobile-user', username: 'fixture', nickname: '', email: 'fixture@example.test', role: 'user', status: 'active', settings: {} };
    let data = [];
    if (path === '/auth/refresh') data = { accessToken: 'fixture', expiresIn: 900, user };
    else if (path === '/auth/me') data = user;
    else if (path === '/site/config') data = { siteName: 'wmind', aiEnabled: false, importEnabled: true, exportEnabled: true, shareEnabled: true, userTemplateEnabled: true };
    else if (path === '/maps/mobile-fixture') {
      if (request.method() === 'PUT') {
        const input = request.postDataJSON();
        writes.push(input);
        saved = structuredClone(input.document);
        version += 1;
      }
      data = { uid: 'mobile-fixture', title: saved.title, document: saved, thumbnailUrl: '', nodeCount: 5, version, sizeBytes: 2048, deleted: false, createdAt: now, updatedAt: now };
    } else if (path === '/public/shares/mobile-fixture') {
      data = { title: sourceDocument.title, document: sourceDocument, allowDownload: true, showNotes: false, siteName: 'wmind', logoUrl: '', ownerNickname: '夹具', createdAt: now, expiresAt: null };
    }
    await route.fulfill({ json: { data, pagination: { page: 1, pageSize: 24, total: 0, totalPages: 1 } } }).catch(() => {});
  });
  await page.goto(`${BASE}/${share ? 's' : 'maps'}/mobile-fixture`);
  const surface = page.locator(share ? '#share-canvas-surface' : '#editor-canvas-surface');
  await surface.locator('[data-topic-id="mobile-root"]').waitFor();
  if (!share && await page.getByRole('button', { name: '隐藏面板', exact: true }).count()) {
    await page.getByRole('button', { name: '隐藏面板', exact: true }).click();
  }
  // Closing the panel transfers focus to its replacement button; enter the canvas before testing gestures.
  if (!share) await page.getByRole('tree').focus();
  await page.waitForTimeout(80);
  const svg = surface.locator('svg[data-read-only]').first();
  const viewport = async () => {
    const raw = await svg.locator('g.viewport').getAttribute('transform');
    const values = raw.match(/translate\(([-\d.e]+)[ ,]+([-\d.e]+)\) scale\(([-\d.e]+)\)/);
    assert.ok(values, raw);
    return { x: Number(values[1]), y: Number(values[2]), zoom: Number(values[3]) };
  };
  const blank = async () => svg.evaluate((element) => {
    const r = element.getBoundingClientRect();
    for (const y of [r.top + 70, r.bottom - 100, r.top + r.height / 2]) {
      for (const x of [r.left + 60, r.left + r.width / 2, r.right - 80]) {
        const hit = document.elementFromPoint(x, y);
        if (element.contains(hit) && !hit.closest('[data-topic-id], [data-summary-id], [data-boundary-id], [data-relationship-id], [data-collapse-toggle]')) return { x, y };
      }
    }
    throw new Error('No blank canvas point found');
  });
  const touch = async (type, points) => {
    await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(({ x, y, id }, index) => ({ x, y, id: id ?? index + 1, radiusX: 1, radiusY: 1, force: 1 })) });
    await page.waitForTimeout(25);
  };
  const dragTouch = async (start, dx, dy) => {
    await touch('touchStart', [start]);
    for (let step = 1; step <= 5; step += 1) await touch('touchMove', [{ x: start.x + dx * step / 5, y: start.y + dy * step / 5 }]);
    await touch('touchEnd', []);
  };
  const node = (id) => surface.locator(`g[data-topic-id="${id}"]`).first();
  const center = async (locator) => {
    const r = await locator.boundingBox();
    assert.ok(r, 'gesture target has a bounding box');
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  };
  const noHistory = () => page.getByRole('button', { name: '撤销', exact: true }).getAttribute('aria-disabled').then((value) => value === 'true');
  const waitForCanvasSettled = () => svg.evaluate((element) => new Promise((resolve, reject) => {
    let previous = '';
    let stableFrames = 0;
    let frames = 0;
    const next = () => {
      if (!element.isConnected) { reject(new Error('Canvas detached before layout settled')); return; }
      const r = element.getBoundingClientRect();
      const snapshot = JSON.stringify([r.x, r.y, r.width, r.height, element.querySelector('g.viewport')?.getAttribute('transform')]);
      stableFrames = snapshot === previous ? stableFrames + 1 : 0;
      previous = snapshot;
      // ResizeObserver may restore the view after the first frame of a CSS size change.
      if (stableFrames >= 2 && r.width > 0 && r.height > 0) { resolve(); return; }
      if (++frames >= 60) { reject(new Error('Canvas geometry and viewport did not settle')); return; }
      requestAnimationFrame(next);
    };
    requestAnimationFrame(next);
  }));
  const pinch = async ({ factor = 1.5, dx = 0, dy = 0, halfDistance = 45 } = {}) => {
    const r = await svg.boundingBox();
    const mid = { x: r.x + r.width / 2, y: r.y + r.height * 0.6 };
    const first = { x: mid.x - halfDistance, y: mid.y, id: 1 };
    const second = { x: mid.x + halfDistance, y: mid.y, id: 2 };
    await touch('touchStart', [first]);
    await touch('touchStart', [first, second]);
    for (let step = 1; step <= 5; step += 1) {
      const fraction = step / 5;
      const distance = halfDistance * (1 + (factor - 1) * fraction);
      await touch('touchMove', [
        { x: mid.x + dx * fraction - distance, y: mid.y + dy * fraction, id: 1 },
        { x: mid.x + dx * fraction + distance, y: mid.y + dy * fraction, id: 2 },
      ]);
    }
    await touch('touchEnd', []);
    return { x: mid.x - r.x, y: mid.y - r.y };
  };
  return { context, page, cdp, svg, surface, viewport, blank, touch, dragTouch, node, center, noHistory, waitForCanvasSettled, pinch, errors, writes, mutations, saved: () => saved };
}

async function scenario(name, options, run) {
  if (process.env.CASE && !new RegExp(process.env.CASE).test(name)) return;
  const f = await fixture(options);
  try {
    await run(f);
    check(`${name}: no browser exception`, f.errors.length === 0);
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
    console.error(`[FAIL] ${name}: ${error.stack}`);
  } finally { await f.context.close(); }
}

try {
  await scenario('mobile toolbar', {}, async ({ page, touch }) => {
    const toolbar = page.locator('[data-editor-toolbar]');
    const metrics = await toolbar.locator('button').evaluateAll((buttons) => buttons.map((button) => {
      const r = button.getBoundingClientRect(); return { top: r.top, width: r.width, height: r.height };
    }));
    check('375px toolbar buttons stay on one row', metrics.every((item) => closeTo(item.top, metrics[0].top, 1)));
    check('toolbar buttons keep their touch target size', metrics.every((item) => item.width >= 36 && item.height >= 36));
    check('toolbar can horizontally scroll', await toolbar.evaluate((element) => element.scrollWidth > element.clientWidth));
    const labels = await toolbar.locator('button').evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label')));
    const seen = new Set();
    for (let attempt = 0; attempt < 8; attempt += 1) {
      for (const label of await toolbar.locator('button').evaluateAll((buttons) => buttons.filter((button) => {
        const r = button.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth;
      }).map((button) => button.getAttribute('aria-label')))) seen.add(label);
      if (await toolbar.evaluate((element) => element.scrollLeft >= element.scrollWidth - element.clientWidth - 2)) break;
      const r = await toolbar.boundingBox();
      await touch('touchStart', [{ x: r.x + r.width - 35, y: r.y + r.height / 2 }]);
      for (let step = 1; step <= 6; step += 1) await touch('touchMove', [{ x: r.x + r.width - 35 - 230 * step / 6, y: r.y + r.height / 2 }]);
      await touch('touchEnd', []);
      await page.waitForTimeout(120);
    }
    check('horizontal touch swipes reach every toolbar button', labels.every((label) => seen.has(label)));
    check('toolbar swiping does not activate a button or leave a tooltip', await page.getByRole('dialog').count() === 0 && await page.getByRole('tooltip').count() === 0);
    check('mobile page itself has no horizontal overflow', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    const insert = toolbar.getByRole('button', { name: '插入', exact: true });
    await insert.focus();
    await insert.tap();
    const menu = page.getByRole('menu', { name: '插入', exact: true });
    await menu.waitFor();
    const r = await menu.boundingBox();
    check('Insert menu remains within the mobile viewport after toolbar scrolling', r.x >= 0 && r.x + r.width <= 376 && r.y >= 0);
    await page.keyboard.press('Escape');
    if (process.env.SCREENSHOT_PATH) {
      await page.getByRole('button', { name: '缩放到适应', exact: true }).click();
      await toolbar.evaluate((element) => { element.scrollLeft = 0; });
      await page.mouse.move(0, 0);
      await page.getByRole('tree').focus();
      await page.waitForTimeout(50);
      await page.screenshot({ path: process.env.SCREENSHOT_PATH });
    }
  });
  await scenario('single-finger canvas pan', {}, async ({ viewport, blank, dragTouch }) => {
    const before = await viewport();
    await dragTouch(await blank(), 90, 45);
    const after = await viewport();
    check('one finger on blank canvas pans by its screen displacement', closeTo(after.x - before.x, 90) && closeTo(after.y - before.y, 45));
    check('single-finger pan preserves zoom', after.zoom === before.zoom);
  });
  await scenario('pinch anchor', {}, async ({ viewport, pinch, noHistory }) => {
    const before = await viewport();
    const anchor = await pinch({ factor: 1.5, dx: 16, dy: 24 });
    const after = await viewport();
    check('two fingers scale the map by their distance ratio', closeTo(after.zoom, before.zoom * 1.5, 0.005));
    check('pinch keeps the world anchor under the moving finger midpoint', closeTo(after.x, anchor.x + 16 - (anchor.x - before.x) / before.zoom * after.zoom) && closeTo(after.y, anchor.y + 24 - (anchor.y - before.y) / before.zoom * after.zoom));
    check('pinch does not add a document undo entry', await noHistory());
  });
  await scenario('pinch limits', {}, async ({ viewport, pinch, noHistory }) => {
    for (let attempt = 0; attempt < 5 && (await viewport()).zoom < 4; attempt += 1) await pinch({ factor: 2 });
    check('pinch respects the 400% upper zoom limit', closeTo((await viewport()).zoom, 4, 0.0001));
    const max = await viewport();
    await pinch({ factor: 1.4, dx: 14, dy: 21 });
    const movedMax = await viewport();
    check('at maximum zoom the finger midpoint can still pan', closeTo(movedMax.zoom, 4, 0.0001) && closeTo(movedMax.x - max.x, 14) && closeTo(movedMax.y - max.y, 21));
    for (let attempt = 0; attempt < 4 && (await viewport()).zoom > 0.2; attempt += 1) await pinch({ factor: 0.2, halfDistance: 60 });
    check('pinch respects the 20% lower zoom limit', closeTo((await viewport()).zoom, 0.2, 0.0001));
    const min = await viewport();
    await pinch({ factor: 0.4, dx: -13, dy: 19, halfDistance: 60 });
    const movedMin = await viewport();
    check('at minimum zoom the finger midpoint can still pan', closeTo(movedMin.zoom, 0.2, 0.0001) && closeTo(movedMin.x - min.x, -13) && closeTo(movedMin.y - min.y, 19));
    check('zoom limits never create document history', await noHistory());
  });
  for (const { name, zoom, factor, dx } of [
    { name: 'maximum', zoom: 4, factor: 2, dx: -18 },
    { name: 'minimum', zoom: 0.2, factor: 0.2, dx: 18 },
  ]) {
    await scenario(`two-finger pan at ${name}`, {}, async ({ viewport, pinch }) => {
      for (let attempt = 0; attempt < 5 && !closeTo((await viewport()).zoom, zoom, 0.0001); attempt += 1) await pinch({ factor });
      const before = await viewport();
      check(`${name} pan fixture starts at its zoom boundary`, closeTo(before.zoom, zoom, 0.0001));
      await pinch({ factor: 1, dx, dy: 12 });
      const after = await viewport();
      check(`two equally moving fingers preserve ${name} zoom`, closeTo(after.zoom, zoom, 0.0001));
      check(`two-finger panning at ${name} follows the midpoint exactly`, closeTo(after.x - before.x, dx) && closeTo(after.y - before.y, 12));
    });
  }
  await scenario('tap and content after pinch', {}, async ({ page, node, center, touch, noHistory }) => {
    const rootPoint = await center(node('mobile-root').locator('text').first());
    await page.touchscreen.tap(rootPoint.x, rootPoint.y);
    check('a normal touch tap still selects a topic', await node('mobile-root').getAttribute('aria-selected') === 'true');
    const todo = node('mobile-a').locator('[data-topic-content-kind="todo"]');
    const point = await center(todo);
    const first = { ...point, id: 1 };
    const second = { x: Math.max(25, point.x - 60), y: point.y + 60, id: 2 };
    await touch('touchStart', [first]);
    await touch('touchStart', [first, second]);
    await touch('touchMove', [first, { ...second, y: second.y + 25 }]);
    await touch('touchEnd', []);
    check('pinch beginning on a todo does not toggle it', await todo.getAttribute('aria-checked') === 'false');
    check('pinch leaves no title editor or document mutation', await page.locator('#editor-canvas-surface textarea').count() === 0 && await noHistory());
    await page.waitForTimeout(400);
    await todo.tap();
    check('a later deliberate todo tap remains usable', await todo.getAttribute('aria-checked') === 'true');
  });
  await scenario('pinch on collapse button', {}, async ({ page, surface, center, touch, noHistory }) => {
    const toggle = surface.locator('[data-collapse-toggle="mobile-a"]');
    const point = await center(toggle);
    const first = { ...point, id: 1 };
    const second = { x: Math.max(30, point.x - 70), y: point.y + 60, id: 2 };
    await touch('touchStart', [first]);
    await touch('touchStart', [first, second]);
    await touch('touchMove', [first, { ...second, y: second.y + 25 }]);
    await touch('touchEnd', []);
    check('pinch starting on a collapse control does not fold its branch', await surface.locator('[data-topic-id="mobile-a1"]').count() === 1 && await noHistory());
    check('pinch on a collapse control does not enter title editing', await page.locator('#editor-canvas-surface textarea').count() === 0);
  });
  await scenario('cancel topic touch', {}, async ({ page, node, center, touch, noHistory }) => {
    const start = await center(node('mobile-a').locator('text').first());
    await touch('touchStart', [start]);
    await touch('touchMove', [{ x: start.x + 45, y: start.y + 35 }]);
    check('topic drag begins only after deliberate touch movement', await page.locator('.wmind-drag-layer').count() === 1);
    await touch('touchCancel', []);
    check('touch cancellation removes the pending drag preview', await page.locator('.wmind-drag-layer').count() === 0);
    check('touch cancellation does not commit a topic move', await noHistory());
  });
  await scenario('ordinary topic touch drag', {}, async ({ page, node, center, blank, dragTouch, noHistory, saved }) => {
    const start = await center(node('mobile-a').locator('text').first());
    const end = await blank();
    const savedDrop = page.waitForResponse((response) => response.request().method() === 'PUT'
      && new URL(response.url()).pathname === '/api/v1/maps/mobile-fixture'
      && response.request().postDataJSON().document.sheets[0].floatingTopics.some((item) => item.id === 'mobile-a'));
    await dragTouch(start, end.x - start.x, end.y - start.y);
    await savedDrop;
    check('a normal one-finger topic drag still commits its drop', !await noHistory() && saved().sheets[0].floatingTopics.some((item) => item.id === 'mobile-a'));
    const savedUndo = page.waitForResponse((response) => response.request().method() === 'PUT'
      && new URL(response.url()).pathname === '/api/v1/maps/mobile-fixture'
      && response.request().postDataJSON().document.sheets[0].rootTopic.children.attached.some((item) => item.id === 'mobile-a'));
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await savedUndo;
    check('one undo restores an ordinary touch topic drag', await noHistory() && saved().sheets[0].rootTopic.children.attached.some((item) => item.id === 'mobile-a'));
  });
  await scenario('topic drag becomes pinch', {}, async ({ page, node, center, touch, viewport, noHistory }) => {
    const p = await center(node('mobile-a').locator('text').first());
    const first = { x: p.x, y: p.y, id: 1 };
    await touch('touchStart', [first]);
    first.x += 12; first.y += 10;
    await touch('touchMove', [first]);
    check('single-finger topic dragging has a live preview', await page.locator('.wmind-drag-layer').count() === 1);
    const second = { x: Math.min(345, first.x + 75), y: first.y + 45, id: 2 };
    await touch('touchStart', [first, second]);
    check('a second finger cancels the topic drag preview immediately', await page.locator('.wmind-drag-layer').count() === 0);
    const before = await viewport();
    second.x += 12; second.y += 28;
    await touch('touchMove', [first, second]);
    check('the second finger takes over map zoom', (await viewport()).zoom > before.zoom);
    await touch('touchEnd', [second]);
    const afterPinch = await viewport();
    first.x += 18; first.y += 22;
    await touch('touchMove', [first]);
    const afterPan = await viewport();
    check('lifting one finger continues as a smooth canvas pan', closeTo(afterPan.x - afterPinch.x, 18) && closeTo(afterPan.y - afterPinch.y, 22));
    await touch('touchEnd', []);
    check('pinch takeover never moves a topic or creates undo history', await noHistory() && await page.locator('.wmind-drag-layer').count() === 0);
  });
  await scenario('third finger and lifecycle cleanup', {}, async ({ page, svg, blank, touch, viewport, dragTouch, noHistory }) => {
    const r = await svg.boundingBox();
    const a = { x: r.x + 80, y: r.y + r.height * 0.65, id: 1 };
    const b = { x: r.x + 250, y: a.y, id: 2 };
    const c = { x: r.x + 160, y: a.y + 80, id: 3 };
    await touch('touchStart', [a, b]);
    const beforeThird = await viewport();
    await touch('touchStart', [a, b, c]);
    check('adding a third finger does not jump the viewport', JSON.stringify(await viewport()) === JSON.stringify(beforeThird));
    await touch('touchMove', [a, b, { ...c, y: c.y + 15 }]);
    await touch('touchEnd', [{ ...c, y: c.y + 15 }]);
    const beforeMove = await viewport();
    await touch('touchMove', [{ ...a, x: a.x + 12, y: a.y + 10 }, { ...b, x: b.x + 12, y: b.y + 10 }]);
    const afterMove = await viewport();
    check('after a third finger lifts the original two-finger pan stays stable', closeTo(afterMove.x - beforeMove.x, 12) && closeTo(afterMove.y - beforeMove.y, 10));
    await touch('touchCancel', []);
    const afterCancel = await viewport();
    await dragTouch(await blank(), 24, 18);
    check('a cancelled gesture accepts a fresh single-finger pan', closeTo((await viewport()).x - afterCancel.x, 24) && closeTo((await viewport()).y - afterCancel.y, 18));
    const p = await blank();
    await touch('touchStart', [p]);
    await touch('touchMove', [{ x: p.x + 10, y: p.y + 10 }]);
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await touch('touchEnd', []);
    const afterBlur = await viewport();
    await dragTouch(await blank(), 22, 16);
    check('window blur clears the previous gesture and allows a new pan', closeTo((await viewport()).x - afterBlur.x, 22) && closeTo((await viewport()).y - afterBlur.y, 16));
    check('cancel and blur leave no drag preview, stuck cursor or document history', await page.locator('.wmind-drag-layer, .wmind-marquee').count() === 0 && await svg.evaluate((element) => getComputedStyle(element).cursor) !== 'grabbing' && await noHistory());
  });
  await scenario('relationship drag becomes pinch', { relationship: true }, async ({ page, svg, touch, center, viewport, noHistory }) => {
    await page.locator('[data-relationship-id="mobile-relation"] text').tap();
    if (await page.getByRole('button', { name: '隐藏面板', exact: true }).count()) await page.getByRole('button', { name: '隐藏面板', exact: true }).click();
    await page.waitForTimeout(80);
    const controls = page.locator('[data-relationship-control]');
    await controls.first().waitFor();
    const path = page.locator('[data-relationship-path]');
    const original = await path.getAttribute('d');
    const p = await center(controls.first());
    const first = { ...p, id: 1 };
    await touch('touchStart', [first]);
    first.x += 20; first.y += 16;
    await touch('touchMove', [first]);
    check('touching a relationship control still previews routing', await path.getAttribute('d') !== original);
    const r = await svg.boundingBox();
    const second = { x: r.x + r.width / 2, y: Math.min(r.y + r.height - 50, first.y + 85), id: 2 };
    await touch('touchStart', [first, second]);
    check('pinch takeover restores the uncommitted relationship path', await path.getAttribute('d') === original);
    const before = await viewport();
    await touch('touchMove', [{ ...first, x: first.x - 10 }, { ...second, y: second.y + 20 }]);
    check('pinch zoom takes priority over relationship controls', (await viewport()).zoom !== before.zoom);
    await touch('touchEnd', []);
    check('relationship pinch takeover creates no undo entry', await noHistory());
  });
  await scenario('lost pointer capture', {}, async ({ page, svg, blank, touch, viewport, dragTouch, noHistory }) => {
    await page.evaluate(() => {
      window.__mobileCaptureId = null;
      document.addEventListener('gotpointercapture', (event) => { window.__mobileCaptureId = event.pointerId; }, { once: true });
    });
    const p = await blank();
    await touch('touchStart', [p]);
    await touch('touchMove', [{ x: p.x + 10, y: p.y + 10 }]);
    check('active canvas pan captures its touch pointer', await svg.evaluate((element) => element.hasPointerCapture(window.__mobileCaptureId)));
    await svg.evaluate((element) => element.releasePointerCapture(window.__mobileCaptureId));
    await touch('touchMove', [{ x: p.x + 10, y: p.y + 10 }]);
    const released = await viewport();
    await touch('touchMove', [{ x: p.x + 40, y: p.y + 40 }]);
    check('lost capture prevents the old pointer from continuing to pan', JSON.stringify(await viewport()) === JSON.stringify(released));
    await touch('touchEnd', []);
    const beforeFresh = await viewport();
    await dragTouch(await blank(), 25, 20);
    check('a fresh gesture works after pointer capture is lost', closeTo((await viewport()).x - beforeFresh.x, 25) && closeTo((await viewport()).y - beforeFresh.y, 20));
    check('lost capture does not produce document history', await noHistory());
  });
  await scenario('view and sheet switch cleanup', { secondSheet: true }, async ({ page, node, center, touch, viewport, blank, dragTouch, noHistory }) => {
    const start = await center(node('mobile-a').locator('text').first());
    await touch('touchStart', [start]);
    await touch('touchMove', [{ x: start.x + 14, y: start.y + 14 }]);
    check('view-switch fixture starts with an active topic drag', await page.locator('.wmind-drag-layer').count() === 1);
    await page.getByRole('tab', { name: '画布 2', exact: true }).click();
    await node('mobile-second-root').waitFor();
    await touch('touchEnd', []);
    check('switching sheets cancels the previous topic drag', await noHistory() && await page.locator('.wmind-drag-layer').count() === 0);
    const beforePan = await viewport();
    await dragTouch(await blank(), 20, 18);
    check('the new sheet immediately accepts touch panning', closeTo((await viewport()).x - beforePan.x, 20) && closeTo((await viewport()).y - beforePan.y, 18));
    const p = await blank();
    await touch('touchStart', [p]);
    await touch('touchMove', [{ x: p.x + 15, y: p.y + 15 }]);
    await page.getByRole('button', { name: '只读预览', exact: true }).click();
    await page.locator('svg[data-read-only="true"]').waitFor();
    const inPreview = await viewport();
    await touch('touchMove', [{ x: p.x + 45, y: p.y + 45 }]);
    await touch('touchEnd', []);
    check('preview does not inherit an active editing-view pointer', JSON.stringify(await viewport()) === JSON.stringify(inPreview));
  });
  await scenario('desktop mouse semantics', { mobile: false }, async ({ page, svg, node, center, blank, viewport, noHistory }) => {
    const target = node('mobile-a');
    const box = await target.boundingBox();
    const beforeMarquee = await viewport();
    await page.mouse.move(box.x - 14, box.y - 14);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width + 14, box.y + box.height + 14, { steps: 6 });
    await page.mouse.up();
    check('desktop blank left-drag still selects topics without Shift', await target.getAttribute('aria-selected') === 'true');
    check('desktop marquee does not pan the canvas', JSON.stringify(await viewport()) === JSON.stringify(beforeMarquee));
    const start = await center(target.locator('text').first());
    await page.getByRole('tree').focus();
    await page.keyboard.down('Space');
    const beforePan = await viewport();
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + 65, start.y + 35, { steps: 6 });
    check('Space plus mouse drag never shows a topic drag or marquee preview', await page.locator('.wmind-drag-layer, .wmind-marquee').count() === 0);
    await page.mouse.up();
    await page.keyboard.up('Space');
    const afterPan = await viewport();
    check('Space plus mouse drag pans even when starting on a topic', closeTo(afterPan.x - beforePan.x, 65) && closeTo(afterPan.y - beforePan.y, 35));
    check('desktop Space panning adds no document history', await noHistory());
    const middle = await blank();
    const beforeMiddle = await viewport();
    await page.mouse.move(middle.x, middle.y);
    await page.mouse.down({ button: 'middle' });
    await page.mouse.move(middle.x + 30, middle.y + 24, { steps: 4 });
    await page.mouse.up({ button: 'middle' });
    const afterMiddle = await viewport();
    check('desktop middle-button panning remains available', closeTo(afterMiddle.x - beforeMiddle.x, 30) && closeTo(afterMiddle.y - beforeMiddle.y, 24));
    check('desktop panning releases the grabbing cursor', await svg.evaluate((element) => getComputedStyle(element).cursor) !== 'grabbing');
  });
  await scenario('desktop first move outside canvas', { mobile: false }, async ({ page, node, center, blank, saved }) => {
    const first = await center(node('mobile-a').locator('text').first());
    await page.mouse.move(first.x, first.y);
    await page.mouse.down();
    // One jump: there is no intermediate SVG pointermove to cross the drag threshold.
    await page.mouse.move(120, 75);
    await page.mouse.up();
    check('releasing outside the canvas clears the old drag preview', await page.locator('.wmind-drag-layer').count() === 0);
    const next = await center(node('mobile-b').locator('text').first());
    const end = await blank();
    const savedDrop = page.waitForResponse((response) => response.request().method() === 'PUT'
      && new URL(response.url()).pathname === '/api/v1/maps/mobile-fixture'
      && response.request().postDataJSON().document.sheets[0].floatingTopics.some((item) => item.id === 'mobile-b'));
    await page.mouse.move(next.x, next.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 5 });
    await page.mouse.up();
    await savedDrop;
    check('the next topic drag moves the newly pressed topic, not a stale target', saved().sheets[0].floatingTopics.some((item) => item.id === 'mobile-b'));
  });
  await scenario('preview touch', {}, async ({ page, viewport, pinch, blank, dragTouch }) => {
    await page.getByRole('button', { name: '只读预览', exact: true }).click();
    await page.locator('svg[data-read-only="true"]').waitFor();
    const before = await viewport();
    await dragTouch(await blank(), 25, 20);
    check('read-only preview allows single-finger blank panning', closeTo((await viewport()).x - before.x, 25) && closeTo((await viewport()).y - before.y, 20));
    const beforePinch = await viewport();
    await pinch({ factor: 1.3 });
    check('read-only preview allows native two-finger zoom', closeTo((await viewport()).zoom, beforePinch.zoom * 1.3, 0.005));
    check('preview touch does not mount editing inputs', await page.locator('#editor-canvas-surface textarea, [data-relationship-control]').count() === 0);
  });
  await scenario('ZEN touch', {}, async ({ page, viewport, pinch, blank, dragTouch, noHistory, waitForCanvasSettled }) => {
    await page.getByRole('button', { name: '进入 ZEN 模式', exact: true }).click();
    await page.getByRole('button', { name: '退出 ZEN', exact: true }).waitFor();
    await waitForCanvasSettled();
    const before = await viewport();
    await dragTouch(await blank(), 32, 20);
    check('ZEN allows single-finger blank panning', closeTo((await viewport()).x - before.x, 32) && closeTo((await viewport()).y - before.y, 20));
    const beforePinch = await viewport();
    await pinch({ factor: 1.25 });
    check('ZEN allows native two-finger zoom', closeTo((await viewport()).zoom, beforePinch.zoom * 1.25, 0.005));
    await page.getByRole('button', { name: '退出 ZEN', exact: true }).click();
    check('ZEN touch gestures add no editing history', await noHistory());
  });
  await scenario('share touch and reset', { share: true }, async ({ page, surface, viewport, pinch, blank, dragTouch, mutations }) => {
    const authored = await viewport();
    await dragTouch(await blank(), 30, 24);
    check('public shares allow single-finger blank panning', closeTo((await viewport()).x - authored.x, 30) && closeTo((await viewport()).y - authored.y, 24));
    const before = await viewport();
    await pinch({ factor: 1.4 });
    check('public shares allow native pinch zoom', closeTo((await viewport()).zoom, before.zoom * 1.4, 0.005));
    await page.getByRole('button', { name: '缩放到适应', exact: true }).click();
    await surface.locator('[data-collapse-toggle="mobile-a"]').tap();
    check('a deliberate share collapse tap remains available', await surface.locator('[data-topic-id="mobile-a1"]').count() === 0);
    check('visitor gestures never issue a mutation request', mutations.length === 0);
    await page.reload();
    await surface.locator('[data-topic-id="mobile-a1"]').waitFor();
    const restored = await viewport();
    check('share reload restores the author zoom and center', closeTo(restored.zoom, authored.zoom, 0.001) && closeTo(restored.x, authored.x) && closeTo(restored.y, authored.y));
    check('share reload restores the author expanded state', await surface.locator('[data-topic-id="mobile-a1"]').count() === 1);
  });
} finally { await browser.close(); }
console.log(`\n${passed} mobile canvas checks passed; ${failures.length} scenarios failed`);
if (failures.length) process.exitCode = 1;
