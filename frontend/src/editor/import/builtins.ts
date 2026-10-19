/**
 * 内置适配器清单。
 *
 * 单独一个文件而不是写进 `index.ts`，是为了让「注册了什么」一眼可见，也避免
 * `import` 顶层产生副作用（`index.ts` 被任何模块引入都会跑一遍注册）。
 *
 * 新增格式时在这里加一行，`importRegistry` 与文件选择框的 `accept` 会自动跟上。
 */

import { createImportRegistry, type ImportRegistry } from './registry';
import { markdownAdapter, opmlAdapter } from './text-adapters';
import type { ImportAdapter } from './types';
import { xmindAdapter } from './xmind';

/**
 * 顺序决定「分数并列时谁赢」（`detect` 取严格最大值）。XMind 只在 zip 上
 * 得分，两个文本格式互斥，所以顺序实际上不影响结果——但保持「结构化格式
 * 优先」的次序，将来加格式时不容易出错。
 */
export const BUILTIN_ADAPTERS: readonly ImportAdapter[] = [xmindAdapter, opmlAdapter, markdownAdapter];

/** 界面用的注册表。测试一律自己 `createImportRegistry([...])`，避免相互污染。 */
export const importRegistry: ImportRegistry = createImportRegistry(BUILTIN_ADAPTERS);

/** 文件选择框的 `accept`：`.xmind,.md,.markdown,.opml,.xml`。 */
export function importAcceptAttribute(adapters: readonly ImportAdapter[] = BUILTIN_ADAPTERS): string {
  return adapters.flatMap((adapter) => adapter.extensions.map((ext) => `.${ext}`)).join(',');
}
