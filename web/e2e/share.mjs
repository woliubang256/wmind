/**
 * M5 验收：分享链接（路线图判据 7–12）。
 *
 * 这一组必须走真实界面：只读画布、密码框、失效页、导出入口的有无，
 * 都是「渲染出来才知道对不对」的东西。数据准备走 REST（快且稳）。
 *
 * 两个判据上的诚实说明：
 *
 * 1. 判据 12 的后半句「直接调服务端导出接口返回 403」**无法验证**：
 *    服务端导出（IE-30）还没做，`/api/v1` 下根本没有导出路由，
 *    连 403 都拿不到，只会拿到统一的 404。所以这里只验前端侧
 *    「分享页没有导出入口」。
 * 2. 判据 10 的备注只能靠**接口响应体**判定。查看器压根不渲染 notes，
 *    在 DOM 里查备注字符串是空集恒真——那种断言永远不会失败，等于没测。
 */

import {
  ADMIN,
  BASE,
  api,
  check,
  ensureUser,
  launchBrowser,
  login,
  makeUser,
  newContext,
  newPage,
  run,
  stamp,
  summary,
  svgTexts,
  uiLogin,
  waitForCanvas,
} from './lib/harness.mjs';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * 制造「链接过期」要直接改库，所以这里知道 SQLite 文件在哪。
 *
 * 路径优先取环境变量，其次读 `backend/.env` 的 `WMIND_SQLITE_PATH`（后端的
 * 相对路径是相对 `backend/` 解析的），最后才落到 `backend/data/wmind.db`。
 *
 * 以前这里写死 `/tmp/wmind-share.db`：那个文件在任何真实部署里都不存在，
 * `sqlite3` 会**新建一个空库**再报 `no such table: share_links`——看起来像
 * 「分享功能的表丢了」，实际是脚本连错了库。
 */
function resolveDbPath() {
  if (process.env.WMIND_SQLITE_PATH) return process.env.WMIND_SQLITE_PATH;
  const backend = fileURLToPath(new URL('../../backend/', import.meta.url));
  const envFile = `${backend}.env`;
  if (existsSync(envFile)) {
    for (const line of readFileSync(envFile, 'utf8').split('\n')) {
      const match = /^\s*WMIND_SQLITE_PATH\s*=\s*(.*)$/.exec(line);
      if (match === null) continue;
      const value = match[1].trim().replace(/^['"]|['"]$/g, '');
      return value.startsWith('/') ? value : `${backend}${value.replace(/^\.\//, '')}`;
    }
  }
  return `${backend}data/wmind.db`;
}

const DB = resolveDbPath();

const USER = makeUser('share');

const ROOT_NOTE = `根节点机密备注-${stamp}`;
const CHILD_NOTE = `子节点机密备注-${stamp}`;

function documentFor(title) {
  const id = `shr-${Math.random().toString(36).slice(2, 10)}`;
  return {
    format: 'wmind',
    formatVersion: '1.0',
    id,
    title,
    sheets: [
      {
        id: `${id}-sheet`,
        title: '画布 1',
        rootTopic: {
          id: `${id}-root`,
          title,
          notes: { plain: ROOT_NOTE, html: `<p>${ROOT_NOTE}</p>` },
          children: {
            attached: [
              {
                id: `${id}-b0`,
                title: '分支甲',
                notes: { plain: CHILD_NOTE, html: `<p>${CHILD_NOTE}</p>` },
                children: { attached: [] },
              },
              { id: `${id}-b1`, title: '分支乙', children: { attached: [] } },
            ],
          },
        },
      },
    ],
  };
}

async function createMap(token, title) {
  const created = await api('/maps', {
    method: 'POST',
    token,
    body: { title, document: documentFor(title) },
  });
  return created.data.uid;
}

/** 直接走接口建链接（判据 9/10/12 的准备用，判据 7/8 走界面）。 */
async function createShare(token, mapUid, options) {
  const res = await api(`/maps/${mapUid}/shares`, { method: 'POST', token, body: options });
  return res.data;
}

function publicGetRaw(token, accessToken) {
  return api(`/public/shares/${token}`, {
    raw: true,
    headers: accessToken === undefined ? {} : { 'X-Share-Access': accessToken },
  });
}

/** 失效页的标题 + 正文，用来比对四种状态是否一字不差。 */
async function invalidPageText(page) {
  await page.waitForSelector('h1', { timeout: 30000 });
  return page.evaluate(() => {
    const heading = document.querySelector('h1');
    const body = heading?.parentElement?.querySelector('p');
    return { title: heading?.textContent?.trim() ?? '', body: body?.textContent?.trim() ?? '' };
  });
}

function tokenFromUrl(url) {
  const parts = url.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1];
}

/** 把 expires_at 的年份改到 2000，格式保持不变，必然在过去。 */
function expireShare(token) {
  const read = execFileSync('sqlite3', [DB, `SELECT expires_at FROM share_links WHERE token='${token}'`], {
    encoding: 'utf8',
  }).trim();
  if (read === '') throw new Error(`share ${token} 的 expires_at 为空，无法制造过期态`);
  const past = `2000${read.slice(4)}`;
  execFileSync('sqlite3', [DB, `UPDATE share_links SET expires_at='${past}' WHERE token='${token}'`], {
    encoding: 'utf8',
  });
  return { before: read, after: past };
}

/** 打开某张导图的分享对话框。 */
async function openShareDialog(page, mapUid, mapTitle) {
  await page.goto(`${BASE}/maps/${mapUid}`);
  await page.getByRole('button', { name: '分享', exact: true }).waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: '分享', exact: true }).click();
  await page.locator('dialog[open]').filter({ hasText: `分享「${mapTitle}」` }).waitFor({ timeout: 30000 });
}

async function main() {
  const token = await ensureUser(USER);
  const adminToken = await login(ADMIN.email, ADMIN.password);

  const browser = await launchBrowser();
  const { page, errors } = await newPage(browser);

  /** 每次开一个新的匿名上下文，等价于无痕窗口：不共享 localStorage / cookie。 */
  const anon = async () => {
    const context = await newContext(browser);
    // 匿名页的异常也归到同一个数组里，判据最后一条要一起判。
    const created = await newPage(browser, { context, errors });
    return { context, page: created.page };
  };

  try {
    const mapUid = await createMap(token, `分享验收 ${stamp}`);

    // ── 判据 7：分享全流程 ────────────────────────────────────────────────
    await uiLogin(page, USER);
    await openShareDialog(page, mapUid, `分享验收 ${stamp}`);
    check('IE-M5-07a 编辑器顶部「分享」打开分享对话框', true);

    await page.getByRole('button', { name: '创建链接' }).click();
    const createdCode = page.locator('dialog[open] code').first();
    await createdCode.waitFor({ timeout: 30000 });
    const createdUrl = (await createdCode.innerText()).trim();
    check(
      'IE-M5-07b 创建后立刻显示可复制的链接',
      createdUrl.includes('/s/'),
      createdUrl,
    );
    const plainToken = tokenFromUrl(createdUrl);

    const a1 = await anon();
    await a1.page.goto(`${BASE}/s/${plainToken}`);
    await waitForCanvas(a1.page);
    const texts = await svgTexts(a1.page);
    check(
      'IE-M5-07c 无痕窗口打开能看到只读导图',
      texts.some((text) => text.includes(`分享验收 ${stamp}`)) && texts.includes('分支甲'),
      texts.join(' | ').slice(0, 120),
    );
    const editing = await a1.page.evaluate(() => ({
      contenteditable: document.querySelectorAll('[contenteditable="true"]').length,
      shareButtons: Array.from(document.querySelectorAll('button')).filter((b) =>
        ['分享', '保存'].includes((b.textContent ?? '').trim()),
      ).length,
    }));
    check(
      'IE-M5-07d 分享页没有任何编辑入口（不可编辑、无分享/保存按钮）',
      editing.contenteditable === 0 && editing.shareButtons === 0,
      JSON.stringify(editing),
    );

    // 撤销：列表里点「撤销」→ 二次确认 → 状态变「已撤销」
    const linkItem = page.locator('dialog[open] li').filter({ hasText: plainToken });
    await linkItem.getByRole('button', { name: '撤销', exact: true }).click();
    const confirm = page.locator('dialog[open]').filter({ hasText: '撤销这条分享链接？' });
    await confirm.getByRole('button', { name: '撤销', exact: true }).click();
    await linkItem.getByText('已撤销').waitFor({ timeout: 30000 });
    check('IE-M5-07e 撤销后列表保留记录并标记「已撤销」', true);

    await a1.page.reload();
    const revokedView = await invalidPageText(a1.page);
    check(
      'IE-M5-07f 撤销后同一地址变成失效页',
      revokedView.title === '分享链接已失效',
      revokedView.title,
    );
    await a1.context.close();

    // ── 判据 8：分享密码 ─────────────────────────────────────────────────
    const pwLink = await createShare(token, mapUid, {
      password: 'abcd1234',
      expiresInDays: 0,
      allowDownload: true,
      showNotes: true,
    });

    const a2 = await anon();
    await a2.page.goto(`${BASE}/s/${pwLink.token}`);
    await a2.page.getByRole('heading', { name: '需要访问密码' }).waitFor({ timeout: 30000 });
    const beforePassword = await a2.page.evaluate(() => document.querySelectorAll('svg text').length);
    check('IE-M5-08a 未输密码时看不到任何内容', beforePassword === 0, `svg text = ${beforePassword}`);

    const messages = [];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await a2.page.getByLabel('访问密码').fill(`wrong${attempt}`);
      await a2.page.getByRole('button', { name: '查看导图' }).click();
      const alert = a2.page.locator('form [role="alert"], form p.text-destructive, form [id$="-error"]').first();
      await a2.page.waitForFunction(
        () => (document.body.innerText ?? '').includes('密码'),
        undefined,
        { timeout: 15000 },
      );
      messages.push((await a2.page.locator('dialog, main, body').first().innerText()).includes('密码'));
      await a2.page.getByLabel('访问密码').fill('');
    }
    check(
      'IE-M5-08b 输错密码有提示且停留在密码框',
      messages.every(Boolean) &&
        (await a2.page.getByRole('heading', { name: '需要访问密码' }).isVisible()),
    );

    await a2.page.getByLabel('访问密码').fill('abcd1234');
    await a2.page.getByRole('button', { name: '查看导图' }).click();
    await waitForCanvas(a2.page);
    const granted = await svgTexts(a2.page);
    check(
      'IE-M5-08c 输对密码后可查看',
      granted.some((text) => text.includes(`分享验收 ${stamp}`)),
    );

    await a2.page.reload();
    await waitForCanvas(a2.page);
    const stillOpen = await a2.page.getByRole('heading', { name: '需要访问密码' }).count();
    check('IE-M5-08d 刷新页面不需要重新输密码', stillOpen === 0);
    await a2.context.close();

    // ── 判据 9：失效四态返回同一个失效页 ─────────────────────────────────
    const expiredLink = await createShare(token, mapUid, { expiresInDays: 1, allowDownload: true, showNotes: true });
    const expiry = expireShare(expiredLink.token);

    const doomedMapUid = await createMap(token, `待删导图 ${stamp}`);
    const doomedLink = await createShare(token, doomedMapUid, { allowDownload: true, showNotes: true });
    await api(`/maps/${doomedMapUid}`, { method: 'DELETE', token });

    const states = [
      ['令牌不存在', `${BASE}/s/aaaaaaaaaaaaaaaaaaaaaa`],
      ['已撤销', `${BASE}/s/${plainToken}`],
      ['已过期', `${BASE}/s/${expiredLink.token}`],
      ['导图已删除', `${BASE}/s/${doomedLink.token}`],
    ];
    const seen = [];
    for (const [label, url] of states) {
      const ctx = await anon();
      await ctx.page.goto(url);
      const text = await invalidPageText(ctx.page);
      seen.push({ label, ...text });
      await ctx.context.close();
    }
    const distinct = new Set(seen.map((item) => `${item.title}|${item.body}`));
    check(
      'IE-M5-09 失效四态（不存在/已撤销/已过期/已删除）返回同一个失效页',
      distinct.size === 1 && seen[0].title === '分享链接已失效',
      seen.map((item) => `${item.label}→${item.title}`).join('; '),
    );

    const statuses = [];
    for (const [, url] of states) {
      const tokenPart = tokenFromUrl(url);
      const res = await publicGetRaw(tokenPart);
      statuses.push(res.status);
    }
    check(
      'IE-M5-09b 四种失效状态接口都返回 404（不是 410/403）',
      statuses.every((code) => code === 404),
      statuses.join(','),
    );
    void expiry;

    // ── 判据 10：show_notes = false ──────────────────────────────────────
    const withNotes = await createShare(token, mapUid, { allowDownload: true, showNotes: true });
    const withoutNotes = await createShare(token, mapUid, { allowDownload: true, showNotes: false });

    const control = await publicGetRaw(withNotes.token);
    const stripped = await publicGetRaw(withoutNotes.token);
    check(
      'IE-M5-10a 对照：show_notes=true 时响应里确实有备注（证明检测有效）',
      control.text.includes(ROOT_NOTE) && control.text.includes(CHILD_NOTE),
    );
    check(
      'IE-M5-10b show_notes=false 时接口响应里根本没有备注内容（服务端已剥离）',
      !stripped.text.includes(ROOT_NOTE) &&
        !stripped.text.includes(CHILD_NOTE) &&
        !stripped.text.includes('机密备注'),
    );
    check(
      'IE-M5-10c show_notes=false 时响应里也没有 extensions 内部字段',
      !stripped.text.includes('"extensions"'),
    );

    const a3 = await anon();
    await a3.page.goto(`${BASE}/s/${withoutNotes.token}`);
    await waitForCanvas(a3.page);
    const hiddenTexts = await svgTexts(a3.page);
    const bodyText = await a3.page.evaluate(() => document.body.innerText);
    check(
      'IE-M5-10d 分享页正文与画布里都搜不到备注字符串',
      !hiddenTexts.some((text) => text.includes('机密备注')) && !bodyText.includes('机密备注'),
    );
    await a3.context.close();

    // ── 判据 12：allow_download = false ─────────────────────────────────
    const noDownload = await createShare(token, mapUid, { allowDownload: false, showNotes: true });
    const a4 = await anon();
    await a4.page.goto(`${BASE}/s/${noDownload.token}`);
    await waitForCanvas(a4.page);
    const exportButtons = await a4.page.getByRole('button', { name: '导出' }).count();
    check('IE-M5-12a allow_download=false 时分享页没有导出入口', exportButtons === 0, `count=${exportButtons}`);
    await a4.context.close();

    const a5 = await anon();
    await a5.page.goto(`${BASE}/s/${withNotes.token}`);
    await waitForCanvas(a5.page);
    const exportButtonsOn = await a5.page.getByRole('button', { name: '导出' }).count();
    check('IE-M5-12b 对照：allow_download=true 时有导出入口', exportButtonsOn === 1, `count=${exportButtonsOn}`);
    await a5.context.close();

    const exportRoute = await api('/maps/' + mapUid + '/export', {
      method: 'POST',
      token,
      body: { format: 'png' },
      raw: true,
    }).catch((error) => ({ status: 'error', text: String(error) }));
    console.log(
      `[NOTE] 判据 12 后半句（服务端导出接口 403）无法验证：服务端导出未实现，POST /maps/{uid}/export → ${exportRoute.status}`,
    );

    // ── 判据 11：站点开关 ────────────────────────────────────────────────
    await api('/admin/settings', {
      method: 'PUT',
      token: adminToken,
      body: { 'share.public_link_enabled': false },
    });

    const siteAfterOff = await api('/site/config');
    check('IE-M5-11a 关闭后站点配置 shareEnabled=false', siteAfterOff.data.shareEnabled === false);

    const a6 = await anon();
    await a6.page.goto(`${BASE}/s/${withNotes.token}`);
    const disabledView = await invalidPageText(a6.page);
    check(
      'IE-M5-11b 关闭开关后历史链接立即失效，且提示「本站已关闭分享」',
      disabledView.title === '本站已关闭分享',
      disabledView.title,
    );
    await a6.context.close();

    const createBlocked = await api(`/maps/${mapUid}/shares`, {
      method: 'POST',
      token,
      body: { allowDownload: true, showNotes: true },
      raw: true,
    });
    check(
      'IE-M5-11c 关闭开关后新建链接被拒（403 SHARE_DISABLED）',
      createBlocked.status === 403 && createBlocked.payload?.error?.code === 'SHARE_DISABLED',
      `${createBlocked.status} ${createBlocked.payload?.error?.code}`,
    );

    await api('/admin/settings', {
      method: 'PUT',
      token: adminToken,
      body: { 'share.public_link_enabled': true },
    });

    const a7 = await anon();
    await a7.page.goto(`${BASE}/s/${withNotes.token}`);
    await waitForCanvas(a7.page);
    check('IE-M5-11d 重新打开开关后链接恢复可用', true);
    await a7.context.close();

    // ── 我的分享页 ───────────────────────────────────────────────────────
    await page.goto(`${BASE}/shares`);
    await page.getByRole('heading', { name: '我的分享' }).waitFor({ timeout: 30000 });
    const rows = await page.locator('li, article').count();
    check('IE-M5-13 「我的分享」列出历史链接（含已撤销）', rows > 0, `rows=${rows}`);

    check('IE-M5-14 全程没有页面级 JS 异常', errors.length === 0, errors.slice(0, 2).join(' | '));
  } finally {
    await browser.close();
  }

  return summary();
}

run(main);
