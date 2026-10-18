/**
 * 新建文档 / 主题 / 主题（配色方案）的构造器。
 *
 * 这里的默认值就是「打开新导图看到的样子」，与 docs/03 §2.5 的示例一致。
 * 所有构造函数都返回**完整**对象（叶子节点的 `children.attached` 是空数组
 * 而非省略），这样遍历代码不用到处写 `?? []`。
 */

import { FORMAT_TAG, FORMAT_VERSION } from './types';
import type {
  Sheet,
  StructureClass,
  Style,
  Theme,
  Topic,
  WmindDocument,
} from './types';
import { newDocumentId, newSheetId, newTopicId } from './ids';

/** 内置默认配色（「彩虹」）。 */
export const RAINBOW_COLORS = [
  '#E53935',
  '#FB8C00',
  '#FDD835',
  '#43A047',
  '#1E88E5',
  '#8E24AA',
] as const;

export function defaultTheme(): Theme {
  return {
    id: 'classic-rainbow',
    name: '彩虹',
    category: 'classic',
    palette: {
      colors: [...RAINBOW_COLORS],
      lineColors: [...RAINBOW_COLORS],
      backgroundColor: '#FFFFFF',
    },
    global: {
      fontFamily: 'sans',
      fontSize: 14,
      lineWidth: 2,
      backgroundColor: '#FFFFFF',
    },
    centralTopic: {
      shape: 'rounded-rect',
      fontSize: 24,
      fontWeight: 700,
      fill: '#1E88E5',
      borderColor: '#1E88E5',
      borderWidth: 0,
      lineWidth: 3,
    },
    mainTopic: {
      shape: 'rounded-rect',
      fontSize: 16,
      fontWeight: 600,
      borderWidth: 0,
      lineWidth: 2,
    },
    subTopic: {
      shape: 'rounded-rect',
      fontSize: 14,
      fontWeight: 400,
      fill: '#FFFFFF',
      borderColor: '#BDBDBD',
      borderWidth: 1,
      lineWidth: 2,
    },
    floatingTopic: {
      shape: 'rounded-rect',
      fontSize: 14,
      fill: '#FFF8E1',
      borderColor: '#FFB300',
      borderWidth: 1,
    },
    summaryTopic: {
      shape: 'underline',
      fontSize: 13,
      fontStyle: 'italic',
      textColor: '#616161',
    },
    boundary: { borderColor: '#999999', borderStyle: 'dash', fill: '#F5F5F5' },
    relationship: { lineColor: '#999999', lineWidth: 1, lineEnd: 'arrow' },
    rainbowBranch: true,
    rainbowColors: [...RAINBOW_COLORS],
    layout: {
      autoBalance: true,
      compact: false,
      alignSiblings: false,
      freeBranch: false,
      flexibleFloating: false,
      topicOverlap: false,
    },
  };
}

/** 新建主题时写入的样式。留空表示全部继承主题——这才是「换主题能整体生效」的前提。 */
const EMPTY_STYLE: Partial<Style> = {};

export interface CreateTopicOptions {
  title?: string;
  id?: string;
  structure?: StructureClass | null;
  style?: Partial<Style> | null;
  collapsed?: boolean;
}

export function createTopic(options: CreateTopicOptions = {}): Topic {
  return {
    id: options.id ?? newTopicId(),
    title: options.title ?? '',
    titleFormat: 'plain',
    structure: options.structure ?? null,
    style: options.style ?? EMPTY_STYLE,
    collapsed: options.collapsed ?? false,
    href: '',
    notes: { plain: '', html: '' },
    labels: [],
    markers: [],
    image: null,
    children: { attached: [], detached: [] },
    summaries: [],
    boundaries: [],
    extensions: [],
  };
}

export interface CreateSheetOptions {
  id?: string;
  title?: string;
  structure?: StructureClass;
  rootTitle?: string;
  themeOverride?: Theme | null;
}

export function createSheet(options: CreateSheetOptions = {}): Sheet {
  return {
    id: options.id ?? newSheetId(),
    title: options.title ?? '画布 1',
    structure: options.structure ?? 'mindmap',
    rootTopic: createTopic({ title: options.rootTitle ?? '中心主题' }),
    floatingTopics: [],
    relationships: [],
    boundaries: [],
    summaries: [],
    themeOverride: options.themeOverride ?? null,
    extensions: [],
  };
}

export interface CreateDocumentOptions {
  title?: string;
  rootTitle?: string;
  theme?: Theme;
  structure?: StructureClass;
  now?: number;
}

export function createDocument(options: CreateDocumentOptions = {}): WmindDocument {
  const now = new Date(options.now ?? Date.now()).toISOString();
  const title = options.title ?? '未命名导图';
  return {
    format: FORMAT_TAG,
    formatVersion: FORMAT_VERSION,
    id: newDocumentId(),
    title,
    theme: options.theme ?? defaultTheme(),
    sheets: [
      createSheet({
        rootTitle: options.rootTitle ?? title,
        structure: options.structure ?? 'mindmap',
      }),
    ],
    meta: { createdAt: now, updatedAt: now, app: 'wmind/1.0.0' },
    extensions: [],
  };
}
