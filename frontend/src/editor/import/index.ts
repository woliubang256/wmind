/**
 * 导入子系统的公共入口。
 *
 * 界面层只 import 这个文件，不直接碰 `zip.ts` / `context.ts`——那两个是
 * 「实现细节」，改起来不该波及 UI。适配器（XMind / Markdown / OPML）在
 * 各自模块里实现 `ImportAdapter`，由这里注册进全局注册表。
 */

export { ImportError, IMPORT_ERROR_CODES, isImportError, toImportError } from './errors';
export type { ImportErrorCode, ImportErrorParams } from './errors';

export {
  errorKey,
  featureKey,
  formatKey,
  toMessageParams,
  unsupportedKey,
  warningKey,
  warningMessage,
} from './format';
export type { MessageParams } from './format';

export { IMPORT_LIMITS, resolveLimits } from './limits';
export type { ImportLimits } from './limits';

export { BUILTIN_ADAPTERS, importAcceptAttribute, importRegistry } from './builtins';
export { createImportRegistry, createImportInput } from './registry';
export type { ImportRegistry } from './registry';

export { sanitizeNotesHtml } from './html';
export { summarizeImport } from './summary';
export { isResourceEntryName, isSafeEntryName, looksLikeZip } from './zip';
export type { ZipArchive } from './zip';

export {
  IMPORT_WARNING_CODES,
  IMPORTED_FEATURES,
  UNSUPPORTED_FEATURES,
} from './types';
export type {
  ImportAdapter,
  ImportContext,
  ImportFormatId,
  ImportIdFactory,
  ImportInput,
  ImportRequest,
  ImportResult,
  ImportSummary,
  ImportWarning,
  ImportWarningCode,
  ImportedFeature,
  UnsupportedFeature,
  UnsupportedSummary,
} from './types';
