/**
 * 八个内置模板。
 *
 * 它们是**前端静态资源**，不经过服务端，与十套内置配色同一个理由
 * （见 `db/queries/shared/themes.sql` 的文件头与 ADR-019）：
 *
 * 1. 选择对话框要渲染实时预览，预览需要文档，所以文档必须在请求回来之前就存在；
 * 2. 模板名是 i18n 键，一个 TEXT 列存不下一份能在两种语言里都成立的文案；
 * 3. 骨架由 `createDocument` / `createTopic` 构造，文档模型新增必填字段时
 *    这里自动跟上，而不是悄悄产出一份非法骨架。
 *
 * 示例文案用**共享词表**（`templates.sample.*`）而不是每模板一套长句：模板的
 * 价值在于「这一层该放什么东西」，而 8 套各写 10 句产品文案既翻不好，也会在
 * 用户改第一个字的时候就消失。
 */

import type { TFunction } from 'i18next';
import { createDocument, createTopic } from '@/editor/model/create';
import { themeById } from '@/editor/theme/palettes';
import type { StructureClass, Topic, WmindDocument } from '@/editor/model/types';

/** 骨架里的一个节点。`n` 会填进文案的 `{{n}}` 占位符。 */
interface SkeletonNode {
  /** `templates.sample.*` 下的键名。 */
  key: string;
  n?: number;
  children?: SkeletonNode[];
}

export interface BuiltinTemplate {
  /** 稳定标识，同时用作 React key 与埋点。 */
  uid: string;
  /** `templates.builtin.*` 下的名字键。 */
  nameKey: string;
  structure: StructureClass;
  /** 默认配色（palettes.json 里的 id）。 */
  paletteId: string;
  skeleton: SkeletonNode;
}

/** 快速造一棵「N 个一级分支、每支 M 个要点」的树。 */
function branches(count: number, childrenPer: number, childKey = 'point'): SkeletonNode[] {
  return Array.from({ length: count }, (_, index) => ({
    key: 'branch',
    n: index + 1,
    children: Array.from({ length: childrenPer }, (_, childIndex) => ({
      key: childKey,
      n: childIndex + 1,
    })),
  }));
}

export const BUILTIN_TEMPLATES: readonly BuiltinTemplate[] = [
  {
    uid: 'mindmap',
    nameKey: 'templates.builtin.mindmap',
    structure: 'mindmap',
    paletteId: 'classic-rainbow',
    skeleton: { key: 'topic', children: branches(4, 2) },
  },
  {
    uid: 'logic',
    nameKey: 'templates.builtin.logic',
    structure: 'logic-right',
    paletteId: 'vivid-code',
    skeleton: {
      key: 'topic',
      children: [
        { key: 'branch', n: 1, children: [{ key: 'point', n: 1 }, { key: 'point', n: 2 }, { key: 'point', n: 3 }] },
        { key: 'branch', n: 2, children: [{ key: 'point', n: 1 }, { key: 'point', n: 2 }] },
        { key: 'branch', n: 3 },
      ],
    },
  },
  {
    uid: 'brace',
    nameKey: 'templates.builtin.brace',
    structure: 'brace',
    paletteId: 'classic-breeze',
    skeleton: {
      key: 'topic',
      children: Array.from({ length: 4 }, (_, index) => ({
        key: 'part',
        n: index + 1,
        children: [{ key: 'subitem', n: 1 }, { key: 'subitem', n: 2 }],
      })),
    },
  },
  {
    uid: 'org',
    nameKey: 'templates.builtin.org',
    structure: 'org-chart',
    paletteId: 'vivid-island',
    skeleton: {
      key: 'topic',
      children: Array.from({ length: 3 }, (_, index) => ({
        key: 'dept',
        n: index + 1,
        children: [{ key: 'team', n: 1 }, { key: 'team', n: 2 }],
      })),
    },
  },
  {
    uid: 'tree',
    nameKey: 'templates.builtin.tree',
    structure: 'tree-right',
    paletteId: 'classic-greentea',
    skeleton: {
      key: 'topic',
      children: Array.from({ length: 3 }, (_, index) => ({
        key: 'category',
        n: index + 1,
        children: [{ key: 'item', n: 1 }, { key: 'item', n: 2 }, { key: 'item', n: 3 }],
      })),
    },
  },
  {
    uid: 'timeline',
    nameKey: 'templates.builtin.timeline',
    structure: 'timeline',
    paletteId: 'vivid-vitality',
    skeleton: {
      key: 'topic',
      children: Array.from({ length: 4 }, (_, index) => ({
        key: 'stage',
        n: index + 1,
        children: [{ key: 'milestone', n: 1 }],
      })),
    },
  },
  {
    uid: 'fishbone',
    nameKey: 'templates.builtin.fishbone',
    structure: 'fishbone',
    paletteId: 'classic-rose',
    skeleton: {
      key: 'topic',
      children: Array.from({ length: 4 }, (_, index) => ({
        key: 'cause',
        n: index + 1,
        children: [{ key: 'detail', n: 1 }, { key: 'detail', n: 2 }],
      })),
    },
  },
  {
    uid: 'treetable',
    nameKey: 'templates.builtin.treetable',
    structure: 'tree-table',
    paletteId: 'vivid-mint',
    skeleton: {
      key: 'topic',
      children: Array.from({ length: 3 }, (_, index) => ({
        key: 'category',
        n: index + 1,
        children: [{ key: 'item', n: 1 }, { key: 'item', n: 2 }],
      })),
    },
  },
] as const;

/** 按 uid 取一个内置模板。 */
export function builtinTemplate(uid: string): BuiltinTemplate | undefined {
  return BUILTIN_TEMPLATES.find((item) => item.uid === uid);
}

/**
 * 结构名的兜底。
 *
 * 服务端存的是从文档里读出来的字符串；万一遇到当前前端不认识的结构（旧版本
 * 存下的、或将来新增的），退回 mindmap，而不是让 `editor.structures.xxx`
 * 在界面上显示成原始键名。
 */
const KNOWN_STRUCTURES = new Set<string>([
  'mindmap', 'logic-right', 'logic-left', 'org-chart', 'tree-right',
  'timeline', 'fishbone', 'brace', 'tree-table',
]);

export function asStructureClass(value: string): StructureClass {
  return KNOWN_STRUCTURES.has(value) ? (value as StructureClass) : 'mindmap';
}

function buildTopic(t: TFunction, node: SkeletonNode): Topic {
  const topic = createTopic({
    title: t(`templates.sample.${node.key}`, node.n === undefined ? undefined : { n: node.n }),
  });
  topic.children.attached = (node.children ?? []).map((child) => buildTopic(t, child));
  return topic;
}

/**
 * 按当前语言构造一份完整的模板文档。
 *
 * **每次调用都生成新的文档 id 与节点 id**：预览用的那几份与真正建图用的那份
 * 是彼此独立的文档。共用同一份会让「从同一个模板建两张图」的两张图带着完全
 * 相同的节点 id，将来做跨导图复制/对比时就是一个坑。
 */
export function buildTemplateDocument(def: BuiltinTemplate, t: TFunction): WmindDocument {
  const name = t(def.nameKey);
  const document = createDocument({
    title: name,
    structure: def.structure,
    theme: themeById(def.paletteId),
  });
  const sheet = document.sheets[0];
  if (sheet) sheet.rootTopic = buildTopic(t, def.skeleton);
  return document;
}
