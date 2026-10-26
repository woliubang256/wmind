/** Direct title typing uses only page-local API fixtures, never development data or credentials. */
import assert from 'node:assert/strict';
import os from 'node:os';
import { chromium } from 'playwright-core';

const BASE = process.env.BASE ?? 'http://127.0.0.1:5199';
const CHROME = process.env.PLAYWRIGHT_CHROMIUM ?? `${os.homedir()}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const now = '2026-10-26T00:00:00Z';
const topic = (id, title, children = []) => ({
  id, title, titleFormat: 'plain', structure: null, style: null, collapsed: false,
  href: '', notes: { plain: '', html: '' }, labels: [], markers: [], image: null,
  children: { attached: children, detached: [] }, summaries: [], boundaries: [], extensions: [],
});
const sourceDocument = {
  format: 'wmind', formatVersion: '1.0', id: 'type-to-edit-doc', title: '直接输入验收',
  sheets: [{
    id: 'type-sheet', title: '画布 1', structure: 'mindmap',
    rootTopic: topic('type-root', '直接输入验收', [
      topic('type-a', '分支 A', [topic('type-a1', '子主题 A1')]),
      topic('type-b', '分支 B'),
    ]),
    floatingTopics: [topic('type-floating', '自由主题')],
    relationships: [], boundaries: [], summaries: [], themeOverride: null, extensions: [],
  }],
  meta: { createdAt: now, updatedAt: now, app: 'wmind/1.0.0' }, extensions: [],
};
let passed = 0;
function check(name, condition) {
  assert.ok(condition, name);
  passed += 1;
  console.log(`[PASS] ${name}`);
}

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox', '--font-render-hinting=none'] });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const errors = [];
  const writes = [];
  let saved = structuredClone(sourceDocument);
  let version = 1;
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace('/api/v1', '');
    const method = request.method();
    const user = { uid: 'type-user', username: 'fixture', nickname: '', email: 'fixture@example.test', role: 'user', status: 'active', settings: {} };
    let data = [];
    if (path === '/auth/refresh') data = { accessToken: 'fixture', expiresIn: 900, user };
    else if (path === '/auth/me') data = user;
    else if (path === '/site/config') data = { siteName: 'wmind', aiEnabled: false, importEnabled: true, exportEnabled: true, shareEnabled: true };
    else if (path === '/maps/type-fixture') {
      if (method === 'PUT') {
        const input = request.postDataJSON();
        writes.push(input);
        saved = structuredClone(input.document);
        version += 1;
      }
      data = { uid: 'type-fixture', title: saved.title, document: saved, thumbnailUrl: '', nodeCount: 5, version, sizeBytes: 2048, deleted: false, createdAt: now, updatedAt: now };
    } else if (path === '/public/shares/type-fixture') {
      data = { title: sourceDocument.title, document: sourceDocument, allowDownload: false, showNotes: false, siteName: 'wmind', logoUrl: '', ownerNickname: '夹具', createdAt: now, expiresAt: null };
    }
    await route.fulfill({ json: { data, pagination: { page: 1, pageSize: 24, total: 0, totalPages: 1 } } }).catch(() => {});
  });

  const canvas = page.getByRole('tree');
  const svg = page.locator('svg[data-read-only="false"]').first();
  const node = (id) => page.locator(`g[data-topic-id="${id}"]`).first();
  const title = (id) => node(id).getAttribute('aria-label');
  const editor = canvas.locator('textarea');
  const open = async () => {
    await page.goto(`${BASE}/maps/type-fixture`);
    await node('type-a').waitFor();
    await canvas.waitFor();
  };
  const select = async (...ids) => {
    await svg.click({ position: { x: 12, y: 12 } });
    for (const [index, id] of ids.entries()) await node(id).click(index ? { modifiers: ['Shift'] } : {});
  };
  const noEditor = async (name) => {
    await page.waitForTimeout(60);
    check(name, await editor.count() === 0);
  };
  const waitTitle = async (id, expected) => {
    await page.waitForFunction(({ id, expected }) => document.querySelector(`g[data-topic-id="${id}"]`)?.getAttribute('aria-label') === expected, { id, expected });
  };
  const key229 = async (key = 'Process', isComposing = true) => {
    await page.evaluate(({ key, isComposing }) => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {
      key, code: key === 'Process' ? 'KeyN' : key, keyCode: 229, which: 229, isComposing,
      bubbles: true, cancelable: true,
    })), { key, isComposing });
  };

  await open();
  await select('type-a');
  await page.keyboard.type('Hello123!');
  await editor.waitFor({ timeout: 1500 });
  check('direct typing keeps the first character and all rapidly typed characters', await editor.inputValue() === 'Hello123!');
  check('the original title is unchanged until submission', await title('type-a') === '分支 A');
  await page.keyboard.press('Escape');
  await noEditor('Escape exits direct title editing');
  check('Escape restores the original title', await title('type-a') === '分支 A');
  check('cancelling an edit adds no undo entry', await page.getByRole('button', { name: '撤销', exact: true }).isDisabled());

  await page.keyboard.type('Replacement');
  await editor.waitFor();
  await page.keyboard.press('Enter');
  await waitTitle('type-a', 'Replacement');
  check('Enter submits a replacement title', await title('type-a') === 'Replacement');
  await page.keyboard.press('ControlOrMeta+z');
  await waitTitle('type-a', '分支 A');
  check('one undo restores the whole original title', await title('type-a') === '分支 A');
  check('direct typing creates only one undo entry', await page.getByRole('button', { name: '撤销', exact: true }).isDisabled());
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await waitTitle('type-a', 'Replacement');
  check('redo restores the complete replacement', await title('type-a') === 'Replacement');
  await page.keyboard.press('ControlOrMeta+z');
  await waitTitle('type-a', '分支 A');

  await page.keyboard.press('F2');
  await editor.waitFor();
  check('F2 opens the original title', await editor.inputValue() === '分支 A');
  check('F2 selects the original title for editing', await editor.evaluate((element) => element.selectionStart === 0 && element.selectionEnd === element.value.length));
  await page.keyboard.press('Escape');
  await node('type-a').dblclick();
  await editor.waitFor();
  check('double-click keeps the original title', await editor.inputValue() === '分支 A');
  await page.keyboard.press('Escape');

  await page.keyboard.type('Line1');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('Line2');
  check('Shift+Enter keeps its native newline inside direct editing', await editor.inputValue() === 'Line1\nLine2');
  await page.keyboard.press('Escape');
  await page.keyboard.type('TopicAfterTab');
  await page.keyboard.press('Tab');
  await waitTitle('type-a', 'TopicAfterTab');
  check('Tab submits the typed title and starts editing a new child', await page.locator('g[data-topic-id]').count() === 6 && await editor.count() === 1 && await editor.inputValue() !== 'TopicAfterTab');
  await page.keyboard.press('Escape');
  await page.keyboard.press('ControlOrMeta+z');
  await page.keyboard.press('ControlOrMeta+z');
  await waitTitle('type-a', '分支 A');
  check('the child and title can be independently undone after Tab', await page.locator('g[data-topic-id]').count() === 5);
  await select('type-a');
  await page.keyboard.type('Navigated');
  await page.keyboard.press('Enter');
  await waitTitle('type-a', 'Navigated');
  await page.keyboard.press(await node('type-a').getAttribute('data-topic-side') === 'left' ? 'ArrowLeft' : 'ArrowRight');
  check('Enter returns focus to the canvas for directional navigation', await node('type-a1').getAttribute('aria-selected') === 'true');
  await page.keyboard.press('Enter');
  await editor.waitFor();
  check('canvas Enter still creates a sibling after direct editing', await page.locator('g[data-topic-id]').count() === 6);
  await page.keyboard.press('Escape');
  await page.keyboard.press('ControlOrMeta+z');
  await page.keyboard.press('ControlOrMeta+z');
  await waitTitle('type-a', '分支 A');

  await select();
  await page.keyboard.type('NoSelection');
  await noEditor('typing with no selection does not edit the central topic');
  check('no selection leaves the central topic unchanged', await title('type-root') === sourceDocument.title);
  await select('type-a', 'type-b');
  await page.keyboard.type('Multiple');
  await noEditor('typing with multiple selected topics does not edit either topic');
  check('multi-selection keeps both titles', await title('type-a') === '分支 A' && await title('type-b') === '分支 B');

  await select('type-a');
  const pageTitle = page.getByRole('textbox', { name: '未命名导图', exact: true });
  await pageTitle.focus();
  await page.keyboard.press('End');
  await page.keyboard.type('x');
  await noEditor('typing in the document title is not captured by topic editing');
  check('document-title input receives its own character', await pageTitle.inputValue() === `${sourceDocument.title}x`);
  await page.keyboard.press('Backspace');
  const styleTab = page.getByRole('tab', { name: '样式', exact: true });
  await styleTab.focus();
  await page.keyboard.type('Panel');
  await noEditor('typing on a panel tab does not edit the selected topic');
  await page.locator('#editor-canvas-panel').getByRole('checkbox', { name: '按内容自适应宽度', exact: true }).click();
  const panelInput = page.locator('#editor-canvas-panel').getByRole('spinbutton', { name: '宽度', exact: true });
  await panelInput.fill('60');
  await panelInput.press('End');
  await page.keyboard.type('0');
  await noEditor('typing inside a sidebar input is not captured by topic editing');
  check('sidebar input retains native typing', await panelInput.inputValue() === '600');
  await page.locator('#editor-canvas-panel').getByRole('checkbox', { name: '按内容自适应宽度', exact: true }).click();
  const zoom = page.getByRole('button', { name: '放大', exact: true });
  await zoom.focus();
  await page.keyboard.type('Button');
  await noEditor('typing on a toolbar button does not edit the selected topic');

  await select('type-a');
  await page.keyboard.down('Space');
  await noEditor('Space keeps its canvas-pan meaning');
  const box = await svg.boundingBox();
  const oldBox = await node('type-a').locator('text').first().boundingBox();
  await page.mouse.move(box.x + 20, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + 90, box.y + 60, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.up('Space');
  await page.waitForFunction(({ x, y }) => {
    const rect = document.querySelector('g[data-topic-id="type-a"] text')?.getBoundingClientRect();
    return rect && Math.abs(rect.x - x - 70) < 2 && Math.abs(rect.y - y - 40) < 2;
  }, { x: oldBox.x, y: oldBox.y });
  const newBox = await node('type-a').locator('text').first().boundingBox();
  check(`Space plus drag still pans the canvas (${Math.round(newBox.x - oldBox.x)}, ${Math.round(newBox.y - oldBox.y)})`, Math.abs(newBox.x - oldBox.x - 70) < 2 && Math.abs(newBox.y - oldBox.y - 40) < 2);
  await noEditor('panning never opens a title editor');

  await select('type-a');
  await key229();
  await editor.waitFor();
  check('IME Process/229 focuses the original selected title before composition', await editor.inputValue() === '分支 A' && await editor.evaluate((element) => element === document.activeElement && element.selectionStart === 0 && element.selectionEnd === element.value.length));
  await cdp.send('Input.imeSetComposition', { text: 'zhong', selectionStart: 5, selectionEnd: 5 });
  check('the active textarea owns the native composition text', await editor.inputValue() === 'zhong');
  for (const key of ['Enter', 'Tab', 'Escape']) {
    await editor.dispatchEvent('keydown', { key, code: key, keyCode: 229, which: 229, isComposing: true });
    check(`${key} during composition does not submit, cancel or create a topic`, await editor.count() === 1 && await title('type-a') === '分支 A' && await page.locator('g[data-topic-id]').count() === 5);
  }
  await key229('Enter', false);
  check('legacy keyCode 229 does not prematurely submit the composing editor', await editor.count() === 1 && await title('type-a') === '分支 A');
  await cdp.send('Input.insertText', { text: '中文' });
  check('native IME commit keeps the complete Chinese title', await editor.inputValue() === '中文');
  await page.keyboard.press('Enter');
  await waitTitle('type-a', '中文');
  check('a later Enter commits the finished Chinese title', await title('type-a') === '中文');
  await page.keyboard.press('ControlOrMeta+z');
  await waitTitle('type-a', '分支 A');
  check('Chinese typing is also undone as a single edit', await title('type-a') === '分支 A');

  await canvas.dispatchEvent('keydown', { key: 'Dead', code: 'Quote', bubbles: true, cancelable: true });
  await editor.waitFor();
  await cdp.send('Input.insertText', { text: 'é' });
  check('dead-key composition preserves the resulting accented character', await editor.inputValue() === 'é');
  await page.keyboard.press('Escape');
  await select('type-floating');
  await page.keyboard.type('Floating');
  await editor.waitFor();
  check('a single floating topic supports direct title typing', await editor.inputValue() === 'Floating');
  await page.keyboard.press('Escape');

  await select('type-a', 'type-b');
  await page.getByRole('button', { name: '概要', exact: true }).click();
  const summary = page.locator('g[data-summary-id]').first();
  await summary.waitFor();
  await summary.locator('text').first().click();
  await page.keyboard.type('Summary');
  await noEditor('typing on a single summary does not enter topic replacement');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await summary.waitFor({ state: 'hidden' });

  await select('type-a');
  await page.getByRole('button', { name: '大纲视图', exact: true }).click();
  const outlineRow = page.locator('[data-outline-row="type-a"]');
  await outlineRow.waitFor();
  await outlineRow.focus();
  await page.keyboard.type('Outline');
  check('typing on an outline row does not mount canvas title editing', await page.locator('#editor-canvas-surface textarea').count() === 0 && await page.locator('textarea').count() === 0);
  await page.getByRole('button', { name: '大纲视图', exact: true }).click();
  await node('type-a').waitFor();

  await select('type-a');
  await page.getByRole('button', { name: '进入 ZEN 模式', exact: true }).click();
  const exitZen = page.getByRole('button', { name: '退出 ZEN', exact: true });
  await exitZen.waitFor();
  await key229();
  await editor.waitFor();
  await cdp.send('Input.imeSetComposition', { text: 'zen', selectionStart: 3, selectionEnd: 3 });
  await editor.dispatchEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 229, which: 229, isComposing: true });
  await page.waitForTimeout(80);
  check('composition Escape keeps ZEN mode and the title editor open', await exitZen.count() === 1 && await editor.count() === 1);
  await cdp.send('Input.insertText', { text: '禅' });
  await page.keyboard.press('Escape');
  check('Escape after composition cancels editing and keeps ZEN mode', await editor.count() === 0 && await exitZen.count() === 1 && await title('type-a') === '分支 A');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '进入 ZEN 模式', exact: true }).waitFor();
  check('a later canvas Escape exits ZEN normally', await exitZen.count() === 0);

  await select('type-a');
  await page.getByRole('button', { name: '只读预览', exact: true }).click();
  const readOnly = page.locator('svg[data-read-only="true"]').first();
  await readOnly.waitFor();
  await readOnly.click({ position: { x: 12, y: 12 } });
  await page.keyboard.type('ReadOnly');
  await page.keyboard.press('F2');
  check('read-only preview has no topic editor', await page.locator('#editor-canvas-surface textarea').count() === 0);
  await page.getByRole('button', { name: '退出预览', exact: true }).click();
  await node('type-a').waitFor();
  check('leaving preview preserves the original topic title', await title('type-a') === '分支 A');

  const savedBranchTitle = (document) => document.sheets[0].rootTopic.children.attached.find((item) => item.id === 'type-a')?.title;
  await select('type-a');
  await key229();
  await cdp.send('Input.insertText', { text: '持久保存' });
  const persisted = page.waitForResponse((response) => {
    const request = response.request();
    return new URL(response.url()).pathname === '/api/v1/maps/type-fixture'
      && request.method() === 'PUT' && savedBranchTitle(request.postDataJSON().document) === '持久保存';
  });
  await page.keyboard.press('Enter');
  await persisted;
  check('a submitted direct title reaches autosave with the document title and root consistent', savedBranchTitle(saved) === '持久保存' && saved.title === saved.sheets[0].rootTopic.title);
  await page.reload();
  await node('type-a').waitFor();
  await waitTitle('type-a', '持久保存');
  check('reloading restores the submitted title from the fixture API', await title('type-a') === '持久保存');
  await select('type-a');
  const beforeCancel = writes.length;
  await key229();
  await cdp.send('Input.insertText', { text: '取消不应保存' });
  await page.keyboard.press('Escape');
  // Autosave debounces content for 800 ms. Viewport-only writes remain valid after an edit is cancelled.
  await page.waitForTimeout(1200);
  check('cancelled direct typing leaves both the canvas and saved title untouched', await title('type-a') === '持久保存' && savedBranchTitle(saved) === '持久保存');
  check('cancelled direct typing produces no content-changing save', writes.slice(beforeCancel).every((input) => savedBranchTitle(input.document) === '持久保存'));

  await page.goto(`${BASE}/s/type-fixture`);
  await page.locator('#share-canvas-surface g[data-topic-id="type-a"]').waitFor();
  const writesBefore = writes.length;
  await page.locator('#share-canvas-surface g[data-topic-id="type-a"]').click();
  await page.keyboard.type('Public');
  await page.keyboard.press('F2');
  check('public shares never mount title-editing inputs', await page.locator('#share-canvas-surface textarea').count() === 0);
  check('public share typing cannot save a document', writes.length === writesBefore);
  check('direct-title scenarios have no browser errors', errors.length === 0);
  await context.close();
  console.log(`\n${passed} direct title typing UI checks passed`);
} finally { await browser.close(); }
