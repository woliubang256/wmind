# Agent Note: 无正文确认弹窗不保留空白层

Status: implemented

## Problem

撤销分享的说明放在 description 中，ConfirmDialog 仍传入空 div，Modal 总是渲染带上下 padding 的正文。标题底边和页脚顶边把空正文夹成两条横线。

## Decision

Modal 的 children 为可选；没有有效 children 时不渲染正文或标题底边，保留页脚顶边作为唯一分隔线。ConfirmDialog 不再提供空 div。有正文的表单弹窗保留原来的滚动区域和分隔方式。

该改动复用[前端基础结构](../../implemented/architecture/2026-10-17-wmind-frontend-m1.md)的原生 dialog，不改变焦点、Esc、取消或确认动作。

## Alternatives considered

- 只去掉其中一条边线改动最小，但仍保留无用途的空白正文，其他无正文 Modal 也会重复出现问题，因此按是否有内容决定结构。

## Verification

- 复现显示修改前有三个区域和两条横线，修改后只有标题区和按钮区以及一条分隔线。
- Esc 和取消均不撤销分享，确认才执行撤销；窄屏无溢出。
- 有正文的表单 Modal 仍有可滚动正文和原有分隔线。

## Consequences

不递归判断自定义组件的渲染结果；调用方应以 null 或省略 children 表达无正文，不能传入空 div。
