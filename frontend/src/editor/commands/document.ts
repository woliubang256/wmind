/**
 * 文档级命令：标题、结构、整份替换。
 */

import { findTopic } from '../model/traverse';
import type { StructureClass, WmindDocument } from '../model/types';
import { defineCommand, type EditorCommand } from './types';

/**
 * 改文档标题。
 *
 * 同时改当前画布的根主题标题——这两个字段在模型里是分开的（`doc.title` 是
 * 文件名/列表项，`rootTopic.title` 是画布上的中心主题），但对用户来说是
 * **同一件事**：页头写着「产品规划」而中心主题写着「未命名导图」，看起来
 * 就像保存串了。XMind 的模型也是「根主题即文件名」。
 *
 * 放在一条命令里而不是派发两次：两次派发会产生两条撤销记录，用户按一次
 * Ctrl+Z 只改回一半，另一半留在原地。
 */
export function changeTitleCommand(title: string): EditorCommand {
  return defineCommand({
    type: 'title.change',
    label: '修改标题',
    coalesceKey: 'title',
    apply(draft, ctx): void {
      draft.title = title;
      const sheet = draft.sheets.find((s) => s.id === ctx.sheetId) ?? draft.sheets[0];
      if (sheet) sheet.rootTopic.title = title;
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
