/**
 * `.wmind` 文档模型。
 *
 * 与 docs/03-数据模型与文件格式.md §2 一一对应。这些类型是**磁盘格式**的
 * 直接映射，不是内部工作模型：字段名、枚举值都照抄规范，改动会破坏存量
 * 文件与 XMind 导入导出。内部派生结构（NodeBox / ComputedStyle）在
 * layout / theme 模块里另立类型。
 */

export type StructureClass =
  | 'mindmap'
  | 'logic-right'
  | 'logic-left'
  | 'org-chart'
  | 'tree-right'
  | 'timeline'
  | 'fishbone'
  | 'brace'
  | 'tree-table';

/** 见 docs/03 §2.4.1。 */
export type ShapeClass =
  | 'rect'
  | 'rounded-rect'
  | 'capsule'
  | 'ellipse'
  | 'circle'
  | 'diamond'
  | 'hexagon'
  | 'parallelogram'
  | 'underline'
  | 'none';

/**
 * 字体族**标识符**，不是字体名。
 *
 * 标识符是封闭集合，可直接当白名单校验；字体名是任意字符串，拼进 CSS/SVG
 * 就是注入面。任何地方都不得把标识符直接当 `font-family` 用——映射在
 * theme/fonts.ts 里。
 */
export type FontFamily = 'sans' | 'system' | 'serif' | 'mono';

export type BorderStyle = 'solid' | 'dash' | 'dot' | 'none';
export type FillPattern = 'solid' | 'none' | 'gradient';
export type LineStyle = 'straight' | 'curve' | 'elbow' | 'none';
export type LineEnd = 'none' | 'arrow' | 'dot';
export type TextAlign = 'left' | 'center' | 'right';
export type TextDecoration = 'none' | 'underline' | 'line-through';
export type FontStyleValue = 'normal' | 'italic';
export type TitleFormat = 'plain' | 'rich';

/** 见 docs/03 §2.4。null / 缺失一律表示「继承主题」。 */
export interface Style {
  shape: ShapeClass;
  fill: string | null;
  fillPattern: FillPattern;
  borderColor: string;
  borderWidth: number;
  borderStyle: BorderStyle;
  fontFamily: FontFamily | null;
  fontSize: number;
  fontWeight: number;
  fontStyle: FontStyleValue;
  textDecoration: TextDecoration;
  textColor: string;
  textAlign: TextAlign;
  width: number;
  autoWidth: boolean;
  lineStyle: LineStyle;
  lineEnd: LineEnd;
  lineWidth: number;
  lineColor: string;
  rainbowBranch: boolean;
  backgroundColor: string | null;
}

export interface ThemePalette {
  colors: string[];
  lineColors: string[];
  backgroundColor: string;
}

export interface ThemeGlobal {
  fontFamily: FontFamily;
  fontSize: number;
  lineWidth: number;
  backgroundColor: string;
}

export interface ThemeLayout {
  autoBalance: boolean;
  compact: boolean;
  alignSiblings: boolean;
  freeBranch: boolean;
  flexibleFloating: boolean;
  topicOverlap: boolean;
}

export interface Theme {
  id: string;
  name: string;
  category: 'vivid' | 'classic' | 'custom';
  palette: ThemePalette;
  global: ThemeGlobal;
  centralTopic: Partial<Style> | null;
  mainTopic: Partial<Style> | null;
  subTopic: Partial<Style> | null;
  floatingTopic: Partial<Style> | null;
  summaryTopic: Partial<Style> | null;
  boundary: Partial<Style> | null;
  relationship: Partial<Style> | null;
  rainbowBranch: boolean;
  rainbowColors: string[];
  layout: ThemeLayout;
}

export interface Marker {
  groupId: string;
  markerId: string;
}

export interface TopicImage {
  src: string;
  width: number;
  height: number;
}

export interface TopicNotes {
  plain: string;
  html: string;
}

export interface Topic {
  id: string;
  title: string;
  titleFormat: TitleFormat;
  structure: StructureClass | null;
  style: Partial<Style> | null;
  collapsed: boolean;
  href: string;
  notes: TopicNotes;
  labels: string[];
  markers: Marker[];
  image: TopicImage | null;
  children: {
    attached: Topic[];
    detached: Topic[];
  };
  summaries: Summary[];
  boundaries: Boundary[];
  extensions: unknown[];
}

export interface Relationship {
  id: string;
  end1Id: string;
  end2Id: string;
  title: string;
  style: Partial<Style> | null;
}

export interface Boundary {
  id: string;
  title: string;
  range: string[];
  style: Partial<Style> | null;
}

export interface Summary {
  id: string;
  /** 汇总节点挂载的父主题。 */
  topicId: string;
  /** 被汇总的主题（保留完整选区，允许跨分支）。 */
  range: string[];
  title: string;
  style: Partial<Style> | null;
}

export interface Sheet {
  id: string;
  title: string;
  structure: StructureClass;
  rootTopic: Topic;
  floatingTopics: Topic[];
  relationships: Relationship[];
  boundaries: Boundary[];
  summaries: Summary[];
  themeOverride: Theme | null;
  extensions: unknown[];
}

export interface DocumentMeta {
  createdAt: string;
  updatedAt: string;
  app: string;
}

export interface WmindDocument {
  format: 'wmind';
  formatVersion: string;
  id: string;
  title: string;
  theme: Theme;
  sheets: Sheet[];
  meta: DocumentMeta;
  extensions: unknown[];
}

/** 当前实现的格式版本。导入更高 major 时拒绝。 */
export const FORMAT_VERSION = '1.0';
export const FORMAT_TAG = 'wmind';

/**
 * 布局与渲染共用的「主题上下文」。
 *
 * depth / branchIndex 决定调色板取色与角色样式，必须在遍历时算好传下去——
 * 让 resolveStyle 自己去反查父链会把 O(1) 变成 O(depth)。
 */
export interface TopicContext {
  depth: number;
  branchIndex: number;
  isRoot: boolean;
  isFloating: boolean;
  isSummary: boolean;
}

export interface ComputedStyle {
  shape: ShapeClass;
  fill: string | null;
  fillPattern: FillPattern;
  borderColor: string;
  borderWidth: number;
  borderStyle: BorderStyle;
  fontFamily: FontFamily;
  fontSize: number;
  fontWeight: number;
  fontStyle: FontStyleValue;
  textDecoration: TextDecoration;
  textColor: string;
  textAlign: TextAlign;
  width: number;
  autoWidth: boolean;
  lineStyle: LineStyle;
  lineEnd: LineEnd;
  lineWidth: number;
  lineColor: string;
  rainbowBranch: boolean;
  backgroundColor: string | null;
}
