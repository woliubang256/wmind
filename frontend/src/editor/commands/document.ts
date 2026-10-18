/**
 * 文档级命令：标题、结构、整份替换。
 */

import { findTopic } from '../model/traverse';
import type { StructureClass, WmindDocument } from '../model/types';
import { defineCommand, type EditorCommand } from './types';

export function changeTitleCommand(title: string): EditorCommand {
  return defineCommand({
    type: 'title.change',
    label: '修改标题',
    coalesceKey: 'title',
    apply(draft): void {
      draft.title = title;
    },
  });
}

/** 改结构。`topicId` 为空表示改整张画布的默认结构。 */
export function changeStructureCommand(structure: StructureClass, topicId?: string): EditorCommand {
  return defineCommand({
    type: 'structure.change',
    label: '切换结构',
    apply(draft, ctx): void {
      if (!topicId) {
        const sheet = draft.sheets.find((s) => s.id === ctx.sheetId);
        if (sheet) sheet.structure = structure;
        return;
      }
      const found = findTopic(draft, topicId);
      if (found) found.topic.structure = structure;
    },
  });
}

/**
 * 整份替换文档（导入、版本回滚、从模板创建）。
 *
 * 这条命令会让撤销栈里的旧快照与新文档完全无关，但这是**正确**的：
 * 用户按撤销就该回到导入前的样子。
 */
export function replaceDocumentCommand(next: WmindDocument): EditorCommand {
  return defineCommand({
    type: 'document.replace',
    label: '替换文档',
    apply(draft): void {
      // 逐字段赋值而不是返回新对象：命令签名约定是「原地修改 draft」，
      // 直接 return 新对象在 immer 里不生效（会被当成 undefined）。
      draft.id = next.id;
      draft.title = next.title;
      draft.theme = next.theme;
      draft.sheets = next.sheets;
      draft.meta = next.meta;
      draft.extensions = next.extensions;
    },
  });
}
