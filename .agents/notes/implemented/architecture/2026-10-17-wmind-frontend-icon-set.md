# Agent Note: 前端图标改为内联 SVG 组件，不引入图标库

Status: implemented

## Problem

前端骨架需要十来个图标（导航、主题切换、空状态、按钮后缀）。按 shadcn/ui 的惯例，第一反应是装 `lucide-react`。

实际卡住的是依赖：本机 pnpm store 里 `lucide-react` 的包目录只剩 `package.json`，`dist/` 与 `esm/` 都没解包出来，`pnpm install` 多次重试仍然失败（同批还有 `vite`、`vitest` 的虚拟目录半成品）。`tsc` 因此直接报 `TS2307: Cannot find module 'lucide-react'`——**不是类型写错，是包不存在**。

这里要定的是：为了十来个图标，是继续和依赖较劲，还是把图标这件小事从依赖里拿掉。

## Decision

自建 `src/components/ui/icon.tsx`：一个 `Icon` 组件 + 一张 `IconName` 联合类型 + 一张 `Record<IconName, ReactNode>` 的 path 表。

- 图标统一 `viewBox="0 0 24 24"`、`fill="none"`、`stroke="currentColor"`、`strokeWidth="1.8"`、圆角端点——与 shadcn/ui 默认视觉一致，且 `currentColor` 让暗色模式零成本跟随。
- `aria-hidden="true"` 固定写死：这些图标全部是文字旁边的装饰，可访问名称由外层按钮的 `aria-label` 或文本承担。
- 组件签名 `SVGProps<SVGSVGElement> & { name: IconName }`，调用侧只写 `<Icon name="files" className="size-4" />`，与原先 `<Files className="size-4" />` 的写法几乎一一对应，迁移是机械替换。
- `lucide-react` 从 `package.json` 移除，`pnpm-lock.yaml` 同步刷新——CI 用 `--frozen-lockfile`，锁文件不同步会直接红。

目前收录 13 个：`arrow-right` `clock` `file-plus` `files` `logout` `moon` `search` `settings` `shield` `sparkles` `sun` `trash` `waypoints`。新增图标就在 `IconName` 与 `paths` 各加一行，类型系统会保证两处不漏。

## Alternatives considered

- **继续排查 `lucide-react` 的解包失败** — 最省事的结果：代码一行不用改。被否是因为失败发生在 pnpm 内容寻址存储层，重试与 `--force` 都无效，而 M0 的验收标准里包含「前端能构建」；为了一个纯装饰依赖去修工具链，优先级明显低于把骨架跑通。**若将来依赖恢复正常，换回 `lucide-react` 的成本只是把 13 个调用点改回组件名**——这个决定是可逆的。
- **每个文件内联自己的 `<svg>`** — 零新文件。被否是因为同一形状（如 `settings`）在导航与管理员菜单里各写一遍，改描边粗细要全仓库搜 `<svg`。
- **用 emoji 当图标** — 零代码。被否是因为 emoji 的渲染由系统字体决定，macOS / Windows / Linux 三个样子，且无法跟随 `currentColor` 做暗色适配。
- **手写一个 SVG sprite + `<use href="#id">`** — 浏览器原生复用。被否是因为 Vite 下要额外处理静态资源与 hash，而 13 个 path 的重复代价几乎为零；等图标规模到几十个再考虑。
- **继续用 `lucide-react` 但在 `vite.config.ts` 里 alias 到 CDN** — 能构建。被否是因为这会把运行时依赖打到公网，与「一条命令私有化部署、零外部依赖」的产品前提冲突。

## Consequences

- **收益**：前端**没有任何图标库依赖**，构建不再受第三方包体积与 tree-shaking 行为影响，`vite build` 产出单 chunk 约 497 kB（gzip 157 kB）。
- **收益**：`IconName` 是闭合联合类型，写错图标名在 `tsc` 阶段就报错，不会静默渲染空白。
- **代价**：图标要手写 path。新增图标时得自己找 24×24 的路径数据，而不是 `import { X } from 'lucide-react'`。
- **代价**：视觉风格由我们维护，与上游 lucide 的图标集不再自动同步。
- **已知上限**：只收录骨架实际用到的图标。等编辑器工具栏需要几十个图标时，应重访本决定（届时依赖问题大概率也已消失）。

## Verification

- `tsc --noEmit` 通过（迁移前该文件报 9 个错误：6 个未使用导入 + 1 个模块缺失 + 2 个 `Icon` 未定义）。
- `vitest run` 5 项通过；`vite build` 通过。
- `grep -r lucide-react frontend/src` 无结果；`pnpm-lock.yaml` 中 `lucide` 计数为 0，与 `package.json` 一致。
