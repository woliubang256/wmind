# Agent Note: 侧栏导航移到顶栏，移动端收进抽屉，编辑器满宽

Status: implemented

## Problem

导图编辑器的可用宽度被侧栏吃掉了一整条：

- 左侧 224px 的固定侧栏在所有页面常驻，包括编辑器。1440px 的屏上画布只剩
  1200px，再套一层 `max-w-7xl`（1280）与 `px-4 py-7`，实际画布区还要窄；
- 侧栏在窄屏直接消失，没有替代入口——手机上除了首页，其余七个页面（模板、
  我的分享、回收站、账号、后台三页）根本点不到；
- 内容区统一 `max-w-7xl` 居中，对列表页是对的，对画布是错的：画布越宽越有用，
  而列表页太宽反而不好读。

## Decision

**导航整体搬到顶栏，移动端用抽屉，编辑器独占满宽。**

顶栏 `h-14`，从左到右：logo + 站点名 → 导航 → 右侧（用户名 / 汉堡 / 主题 / 退出）。

- **`md` 到 `xl` 之间只显示图标**，`xl` 以上才带文字。八条链接带文字在 768px
  上必然折行，折行后顶栏突然变高、画布跟着跳一下。图标保留 `title` 与
  `aria-label`，悬停和读屏都拿得到名字。
- **移动端抽屉用原生 `<dialog>` + `showModal()`**。焦点陷阱、Esc 关闭、
  `::backdrop` 全由浏览器负责，不自己造遮罩。原生 dialog 靠 `margin: auto`
  居中，而 Tailwind preflight 已经把 margin 清零，所以 `m-0 h-svh w-72`
  直接落到左上角，天然就是一条侧栏。
- **`/maps/*` 走满宽分支**：

  ```tsx
  const fullBleed = location.pathname.startsWith('/maps/');
  {fullBleed
    ? <main className="min-w-0"><Outlet /></main>
    : <main className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6"><Outlet /></main>}
  ```

  这一步是必须的。只把侧栏换成顶栏、内容区还留着 `max-w-7xl`，等于只还了一半
  空间——1280 的封顶照样卡在画布中间。
- 编辑器高度改成 `h-[calc(100svh-3.5rem)]`（顶栏正好 56px），并去掉原来的
  `rounded-2xl border`：它现在贴着视口边缘，圆角和描边只会露出一圈没用的灰边。

## Consequences

- 列表页仍然是居中的内容列，画布是满宽——两种版式并存，靠一条路径判断切换。
  代价是 `AppLayout` 里出现了一个 `fullBleed` 分支，以后新增满宽页面要记得加。
- 抽屉在 `location.pathname` 变化时自动收起。手机上点完链接还盖着半屏菜单
  是这类抽屉的常态 bug。
- 导航高亮仍是「更具体的前缀优先」（`/admin/users` 同时以 `/admin` 开头），
  搬位置时这段逻辑原样保留。
- 顺手加了两条 i18n：`nav.menu`（抽屉标题 / 汉堡按钮名）、`nav.primary`（导航
  地标名）。`locales.test.ts` 要求两份语言包键集合完全一致，所以两边同时加。
- 界面验收脚本里凡是 `page.locator('svg').first()` 的地方都要改：顶栏 logo 现在
  是页面上第一个 `<svg>`，点它等于点了「回首页」的链接。画布要点名
  `svg[data-read-only="false"]`。

## Alternatives considered

- **侧栏做成可折叠。** 折叠状态要持久化、要有动画、要在窄屏自动折——三件事
  加起来比「搬到顶栏」复杂得多，而用户要的只是「画布更大」。
- **只在编辑器页隐藏侧栏。** 顶栏/侧栏两套导航并存，视觉上会跳；而且离开编辑器
  时画布宽度突然变窄，看起来像布局抖动。
- **移动端用横向滚动的标签条。** 八条链接在 375px 上横向滚动，滚动条根本看不出来，
  用户会以为「我的分享」之后就没有了。
- **自己写遮罩 + `overflow: hidden` + 手动焦点陷阱。** 原生 dialog 已经把这三样
  都做了，且 Esc 与焦点归还的行为和系统其他弹窗一致。
