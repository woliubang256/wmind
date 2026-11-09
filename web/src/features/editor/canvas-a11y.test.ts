import { describe, expect, it } from 'vitest';
import { canvasLabel, selectionAnnouncement, type SelectedTopicInfo } from './canvas-a11y';

function info(overrides: Partial<SelectedTopicInfo> = {}): SelectedTopicInfo {
  return { title: '分支 A', level: 2, childCount: 0, collapsed: false, ...overrides };
}

describe('canvasLabel', () => {
  it('把标题与主题数一起交给文案', () => {
    expect(canvasLabel({ title: '项目计划', nodeCount: 12 })).toEqual({
      key: 'editor.a11y.canvasLabel',
      params: { title: '项目计划', total: 12 },
    });
  });

  it('空标题也照常产出（由调用方决定显示什么）', () => {
    const message = canvasLabel({ title: '', nodeCount: 1 });
    expect(message.params.title).toBe('');
    expect(message.params.total).toBe(1);
  });
});

describe('selectionAnnouncement', () => {
  it('没选中时说「未选中」', () => {
    expect(selectionAnnouncement([])).toEqual({
      key: 'editor.a11y.selectionNone',
      params: {},
    });
  });

  it('选中叶子节点时报层级并说明没有子主题', () => {
    expect(selectionAnnouncement([info()])).toEqual({
      key: 'editor.a11y.selectionLeaf',
      params: { title: '分支 A', level: 2, children: 0 },
    });
  });

  it('选中带子节点的节点时报子主题数', () => {
    expect(selectionAnnouncement([info({ childCount: 3 })])).toEqual({
      key: 'editor.a11y.selectionParent',
      params: { title: '分支 A', level: 2, children: 3 },
    });
  });

  it('折叠状态单独一条文案，否则用户不知道下面还有东西', () => {
    expect(selectionAnnouncement([info({ childCount: 4, collapsed: true })])).toEqual({
      key: 'editor.a11y.selectionCollapsed',
      params: { title: '分支 A', level: 2, children: 4 },
    });
  });

  it('多选只报数量，不逐个念名字', () => {
    const many = [info({ title: 'A' }), info({ title: 'B' }), info({ title: 'C' })];
    expect(selectionAnnouncement(many)).toEqual({
      key: 'editor.a11y.selectionMany',
      params: { total: 3 },
    });
  });

  it('只播报第一个节点的详情，不会把多选当成单选', () => {
    // 两个节点时必须是 selectionMany，不能退化成「已选中 A」。
    const message = selectionAnnouncement([info({ title: 'A' }), info({ title: 'B' })]);
    expect(message.key).toBe('editor.a11y.selectionMany');
  });

  it('根节点的层级是 1（depth 0 → aria-level 1 的约定在这里也成立）', () => {
    expect(selectionAnnouncement([info({ level: 1 })])).toEqual({
      key: 'editor.a11y.selectionLeaf',
      params: { title: '分支 A', level: 1, children: 0 },
    });
  });
});
