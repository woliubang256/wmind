/**
 * 导出与界面语言的验收。
 *
 * 两件事放在一个脚本里，因为它们共用同一条链路：**导出对话框的文案本身
 * 就要被翻译**。切到英文之后打开导出对话框，格式名、说明、页脚尺寸都该是
 * 英文——这是唯一能同时证明「PDF 真的能下」与「en-US 不是摆设」的地方。
 *
 * 下载走 Playwright 的 download 事件，拿临时文件读字节。断言只看**结构**，
 * 不比整个文件：PDF 里有创建时间，逐字节比对必然每天红一次。
 */

import fs from 'node:fs/promises';
import { ADMIN, BASE, api, check, ensureUser, launchBrowser, login, makeUser, newPage, run, stamp, uiLogin, waitForCanvas } from './lib/harness.mjs';

const USER = makeUser('export');

/** 改站点导出开关。走管理员接口——界面那条由 UI 断言负责。 */
async function setExportEnabled(token, enabled) {
  return api('/admin/settings', {
    method: 'PUT',
    token,
    body: { 'feature.export_enabled': enabled },
  });
}

/** 一棵足够大、又有中文的树：中文标题会走 PDF 的 UTF-16BE 分支。 */
function documentFor(title) {
  const topic = (id, text, children = []) => ({
    id,
    title: text,
    notes: { plain: '', html: '' },
    labels: [],
    style: {},
    collapsed: false,
    children: { attached: children, detached: [] },
    markers: [],
    image: null,
    link: null,
  });
  return {
    format: 'wmind',
    version: 1,
    title,
    themeId: 'default',
    meta: { createdAt: 0, updatedAt: 0 },
    sheets: [
      {
        id: 'sheet-1',
        title: '画布 1',
        structure: 'mindmap',
        rootTopic: topic('t-root', `导出验收 ${stamp}`, [
          topic('t-a', '分支 A', [topic('t-a1', '叶子 A1'), topic('t-a2', 'Leaf A2')]),
          topic('t-b', '分支 B'),
          topic('t-c', 'Branch C'),
        ]),
        floatingTopics: [],
        relationships: [],
        boundaries: [],
        summaries: [],
        style: {},
      },
    ],
  };
}

/** 读下载下来的文件。`download.path()` 给的是 Playwright 的临时副本。 */
async function readDownload(download) {
  const file = await download.path();
  return fs.readFile(file);
}

/** 从 PDF 里抠出 MediaBox 的宽高（point）。 */
function mediaBox(bytes) {
  const source = bytes.toString('latin1');
  const match = /\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/.exec(source);
  return match === null ? null : { width: Number(match[1]), height: Number(match[2]) };
}

async function openExportDialog(page, mapUid, label = '导出') {
  await page.goto(`${BASE}/maps/${mapUid}`);
  await waitForCanvas(page);
  await page.getByRole('button', { name: label }).click();
  const dialog = page.locator('dialog[open]');
  await dialog.waitFor({ timeout: 30000 });
  return dialog;
}

/**
 * 等对话框真的关掉。
 *
 * `downloadBlob` 之后组件会立刻 `onClose()`，但那是下一帧的事。原生
 * `<dialog>.showModal()` 会把背景整片设为 inert——不等它关，紧接着去点工具栏
 * 的「导出」会一直等到超时，报错还是「元素不可见」这种看不出根因的话。
 */
async function waitClosed(page) {
  await page.locator('dialog[open]').waitFor({ state: 'hidden', timeout: 30000 });
}

async function main() {
  const token = await ensureUser(USER);
  const title = `导出验收 ${stamp}`;
  const created = await api('/maps', {
    method: 'POST',
    token,
    body: { title, document: documentFor(title) },
  });
  const uid = created.data.uid;

  const browser = await launchBrowser();
  const { page, errors } = await newPage(browser);

  try {
    await uiLogin(page, USER);

    // ── 1. 导出对话框里有 PDF ────────────────────────────────
    let dialog = await openExportDialog(page, uid);
    const formats = await dialog.locator('input[name="export-format"]').count();
    check('IE-M7-01 导出对话框列出六个格式', formats === 6, `实际 ${formats}`);
    // 单选按钮的可见文字包在 `<label>` 里，input 自身没有文本——所以按角色名匹配，
    // 不能拿 `hasText` 过滤 input。
    check(
      'IE-M7-02 格式列表含 PDF',
      (await dialog.getByRole('radio', { name: 'PDF' }).count()) === 1,
    );

    // ── 2. 选 PDF：预览仍在，页脚改报毫米 ────────────────────
    await dialog.getByRole('radio', { name: 'PDF' }).check();
    await page.waitForTimeout(400);
    check('IE-M7-03 选 PDF 后仍有预览图', (await dialog.locator('img').count()) === 1);

    const dialogText = (await dialog.textContent()) ?? '';
    const pageSize = /页面 (\d+) × (\d+) mm/.exec(dialogText);
    check('IE-M7-04 页脚按毫米报页面尺寸', pageSize !== null, pageSize?.[0]);

    check(
      'IE-M7-05 PDF 的说明写清「文字不可选中」',
      dialogText.includes('不可选中'),
    );

    // ── 3. 下载 PDF，验结构 ─────────────────────────────────
    const [pdfDownload] = await Promise.all([
      page.waitForEvent('download', { timeout: 60000 }),
      dialog.getByRole('button', { name: /下载 PDF/ }).click(),
    ]);
    const pdfBytes = await readDownload(pdfDownload);
    const pdfText = pdfBytes.toString('latin1');

    check('IE-M7-06 PDF 以 %PDF-1.4 开头', pdfText.startsWith('%PDF-1.4'));
    check('IE-M7-07 PDF 以 %%EOF 收尾', pdfText.trimEnd().endsWith('%%EOF'));
    check('IE-M7-08 PDF 内嵌 JPEG（DCTDecode）', pdfText.includes('/Filter /DCTDecode'));
    check('IE-M7-09 文件名是 .pdf', pdfDownload.suggestedFilename().endsWith('.pdf'), pdfDownload.suggestedFilename());

    const box = mediaBox(pdfBytes);
    check('IE-M7-10 MediaBox 存在且为正', box !== null && box.width > 1 && box.height > 1, JSON.stringify(box));

    // 页面尺寸与页脚报的毫米数必须对得上（±1mm 取整误差）。
    if (box !== null && pageSize !== null) {
      const mmW = Math.round(box.width * (25.4 / 72));
      const mmH = Math.round(box.height * (25.4 / 72));
      check(
        'IE-M7-11 页脚毫米数与 MediaBox 一致',
        Math.abs(mmW - Number(pageSize[1])) <= 1 && Math.abs(mmH - Number(pageSize[2])) <= 1,
        `MediaBox ${mmW}×${mmH}mm / 页脚 ${pageSize[1]}×${pageSize[2]}mm`,
      );
    } else {
      check('IE-M7-11 页脚毫米数与 MediaBox 一致', false, '缺少 MediaBox 或页脚尺寸');
    }

    // 交叉引用表的偏移必须指向 xref 本身，否则阅读器直接报文件损坏。
    const startxref = Number(/startxref\s+(\d+)/.exec(pdfText)?.[1]);
    check(
      'IE-M7-12 startxref 指向 xref 表',
      pdfText.slice(startxref, startxref + 4) === 'xref',
      `startxref=${startxref}`,
    );

    // ── 4. 回归：SVG 分支没被 PDF 弄坏 ──────────────────────
    await waitClosed(page);
    dialog = await openExportDialog(page, uid);
    // 选项状态在组件里，关掉再开还停在 PDF 上——这正是要验的：换格式必须能换。
    await dialog.getByRole('radio', { name: /^SVG/ }).check();
    await page.waitForTimeout(300);
    const [svgDownload] = await Promise.all([
      page.waitForEvent('download', { timeout: 60000 }),
      dialog.getByRole('button', { name: /下载 SVG/ }).click(),
    ]);
    const svgText = (await readDownload(svgDownload)).toString('utf8');
    check('IE-M7-13 SVG 导出仍是矢量文本', svgText.includes('<svg') && svgText.includes('分支 A'));
    await waitClosed(page);

    // ── 5. 界面语言：切到英文 ───────────────────────────────
    await page.goto(`${BASE}/account`);
    await page.getByRole('radiogroup', { name: '界面语言' }).waitFor({ timeout: 30000 });
    await page.getByRole('radio', { name: 'English' }).click();
    await page.waitForTimeout(500);

    check(
      'IE-M7-14 切到英文后导航变英文',
      (await page.getByRole('link', { name: 'Recent' }).count()) > 0,
      await page.locator('aside').first().textContent(),
    );
    check(
      'IE-M7-15 html[lang] 同步为 en-US',
      (await page.evaluate(() => document.documentElement.lang)) === 'en-US',
    );
    check(
      'IE-M7-16 账号页标题变英文',
      (await page.getByRole('heading', { level: 1, name: 'Account' }).count()) > 0,
      await page.locator('h1').first().textContent(),
    );

    // ── 6. 英文下导出对话框也是英文 ──────────────────────────
    const enDialog = await openExportDialog(page, uid, 'Export');
    // 选项状态会跟着组件留到下一次打开（上一步停在 SVG），所以这里要重新选 PDF：
    // 否则验不到 PDF 那条说明与「页面 … mm」页脚在英文下的样子。
    await enDialog.getByRole('radio', { name: 'PDF' }).check();
    await page.waitForTimeout(400);
    const enText = (await enDialog.textContent()) ?? '';
    check('IE-M7-17 英文下对话框标题是 Export map', enText.includes('Export map'));
    // 整块文本里一个汉字都不该有——这比逐条比对更能抓住漏翻的地方。
    const cjk = /[\u4e00-\u9fa5]+/.exec(enText)?.[0] ?? '';
    check(
      'IE-M7-18 英文下对话框没有残留中文',
      enText.includes('SVG (vector)') &&
        enText.includes('Page ') &&
        enText.includes('rasterised') &&
        cjk === '',
      cjk === '' ? '无中文' : `残留：${cjk}`,
    );
    await page.keyboard.press('Escape');
    await waitClosed(page);

    // ── 7. 刷新后语言保持 ───────────────────────────────────
    // 用具体元素等，不用 `networkidle`：编辑器有长连与轮询，永远等不到「静默」。
    await page.reload();
    await page.getByRole('link', { name: 'Recent' }).waitFor({ timeout: 30000 });
    // 同时验 `html[lang]` 与存储值：只验前者的话，把持久化删掉、改成「每次按浏览器
    // 语言算」也能过——而那条路在英文系统上永远回不到中文。
    const stored = await page.evaluate(() => window.localStorage.getItem('wmind:locale'));
    check(
      'IE-M7-19 刷新后仍是英文（localStorage 生效）',
      (await page.evaluate(() => document.documentElement.lang)) === 'en-US' && stored === 'en-US',
      `wmind:locale=${stored}`,
    );

    // ── 8. 切回中文 ─────────────────────────────────────────
    await page.goto(`${BASE}/account`);
    await page.getByRole('radio', { name: '中文' }).click();
    await page.waitForTimeout(400);
    check(
      'IE-M7-20 切回中文后导航恢复',
      (await page.getByRole('link', { name: '最近' }).count()) > 0,
    );
    check(
      'IE-M7-21 html[lang] 回到 zh-CN',
      (await page.evaluate(() => document.documentElement.lang)) === 'zh-CN',
    );

    check('IE-M7-22 全程没有未捕获异常', errors.length === 0, errors.slice(0, 2).join(' | '));

    // ── 9. 站点关掉导出之后，入口要消失 ──────────────────────
    // 导出全在浏览器里做，服务端拦不住——所以「关掉导出」这件事只可能靠界面
    // 兑现。只验按钮消失，不验「拦住了请求」：后者在这个架构下不成立。
    const adminToken = await login(ADMIN.email, ADMIN.password);
    await setExportEnabled(adminToken, false);

    // 同一个 context 开新页：Cookie 还在，但 React Query 缓存是新的。
    // 直接 reload 会拿到 5 分钟内仍然「新鲜」的旧配置，验不出开关的效果。
    const closed = await page.context().newPage();
    await closed.goto(`${BASE}/maps/${uid}`);
    await waitForCanvas(closed);
    check(
      'IE-M7-23 关闭导出后编辑器没有「导出」按钮',
      (await closed.getByRole('button', { name: '导出' }).count()) === 0,
    );
    await closed.close();

    await setExportEnabled(adminToken, true);
    const reopened = await page.context().newPage();
    await reopened.goto(`${BASE}/maps/${uid}`);
    await waitForCanvas(reopened);
    check(
      'IE-M7-24 重新打开后「导出」按钮回来',
      (await reopened.getByRole('button', { name: '导出' }).count()) === 1,
    );
    await reopened.close();
  } finally {
    // 异常中止也要把开关放回去，否则下一轮这套脚本的前半段会红。
    try {
      const adminToken = await login(ADMIN.email, ADMIN.password);
      await setExportEnabled(adminToken, true);
    } catch {
      // 收尾失败不覆盖原始失败信息。
    }
    await browser.close();
  }
}

run(main);
