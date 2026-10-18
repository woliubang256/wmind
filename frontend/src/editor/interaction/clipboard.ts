/**
 * 主题剪贴板。
 *
 * 只做**应用内**剪贴板，不碰系统剪贴板。理由：
 *
 * 1. 导图的复制单位是「子树 + 样式 + 备注」，纯文本装不下；序列化成
 *    JSON 塞进系统剪贴板又会在粘贴到其他应用时露出一坨乱码。
 * 2. `navigator.clipboard.writeText` 需要用户手势与权限，读写失败在
 *    Firefox / Safari 上的表现各不相同，为一个 M2 阶段用不到的能力
 *    引入一堆降级分支不划算。
 *
 * M3 做导入导出时再补 `text/html`（嵌套 `<ul>`）与 `application/x-wmind`
 * 两个 MIME 类型的双向读写——那时才需要跨应用粘贴。
 *
 * 存的是深拷贝：剪贴板内容必须和文档脱钩，否则「复制 → 改原节点 → 粘贴」
 * 会粘出改过之后的内容，与用户的预期相反。
 */

import type { Topic } from '../model/types';

let snapshot: Topic[] = [];

export function copyToClipboard(topics: readonly Topic[]): void {
  if (topics.length === 0) return;
  snapshot = topics.map((topic) => structuredClone(topic));
}

export function readClipboard(): Topic[] {
  return snapshot;
}

export function hasClipboardContent(): boolean {
  return snapshot.length > 0;
}

/** 仅测试用：模块级状态在用例之间会串味。 */
export function clearClipboard(): void {
  snapshot = [];
}
