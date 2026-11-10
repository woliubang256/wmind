package mcp

import (
	"encoding/json"
	"testing"
)

const sampleDoc = `{
  "format": "wmind",
  "formatVersion": "1.0",
  "id": "doc-1",
  "title": "产品规划",
  "theme": {"palette": "fresh", "unknownField": {"keep": true}},
  "sheets": [{
    "id": "sheet-1",
    "title": "画布 1",
    "rootTopic": {
      "id": "root",
      "title": "产品规划",
      "style": {"fill": "#123456"},
      "children": {"attached": [
        {"id": "a", "title": "用户研究", "notes": "别丢我", "children": {"attached": [
          {"id": "a1", "title": "访谈"}
        ]}},
        {"id": "b", "title": "上线计划", "children": {"attached": []}}
      ], "detached": []}
    }
  }]
}`

// 改标题只动 title 字段：样式、备注、未知字段必须原样保留。
func TestRenameTopicKeepsOtherFields(t *testing.T) {
	doc, err := parseDocument([]byte(sampleDoc))
	if err != nil {
		t.Fatalf("解析失败: %v", err)
	}
	if err := doc.renameTopic("a", "用户调研"); err != nil {
		t.Fatalf("改名失败: %v", err)
	}
	raw, err := doc.bytes()
	if err != nil {
		t.Fatalf("编码失败: %v", err)
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("回读失败: %v", err)
	}
	theme := out["theme"].(map[string]any)
	if _, ok := theme["unknownField"]; !ok {
		t.Fatal("未知字段被丢掉了")
	}
	sheet := out["sheets"].([]any)[0].(map[string]any)
	root := sheet["rootTopic"].(map[string]any)
	first := root["children"].(map[string]any)["attached"].([]any)[0].(map[string]any)
	if first["title"] != "用户调研" {
		t.Fatalf("标题没改到: %v", first["title"])
	}
	if first["notes"] != "别丢我" {
		t.Fatal("备注被丢掉了")
	}
	if root["style"].(map[string]any)["fill"] != "#123456" {
		t.Fatal("样式被丢掉了")
	}
}

func TestAddChildAndCount(t *testing.T) {
	doc, _ := parseDocument([]byte(sampleDoc))
	before := doc.nodeCount()
	newID, err := doc.addChild("a1", "问卷")
	if err != nil {
		t.Fatalf("加子主题失败: %v", err)
	}
	if newID == "" {
		t.Fatal("没有返回新 id")
	}
	if got := doc.nodeCount(); got != before+1 {
		t.Fatalf("节点数应为 %d，实际 %d", before+1, got)
	}
	outline, err := doc.outline()
	if err != nil {
		t.Fatalf("大纲失败: %v", err)
	}
	// root → a → a1 → 问卷
	if len(outline.Children) != 2 || len(outline.Children[0].Children) != 1 ||
		len(outline.Children[0].Children[0].Children) != 1 {
		t.Fatalf("层级不对: %+v", outline)
	}
}

func TestDeleteTopicRemovesSubtree(t *testing.T) {
	doc, _ := parseDocument([]byte(sampleDoc))
	if err := doc.deleteTopic("a"); err != nil {
		t.Fatalf("删除失败: %v", err)
	}
	outline, _ := doc.outline()
	if len(outline.Children) != 1 || outline.Children[0].ID != "b" {
		t.Fatalf("子树没删干净: %+v", outline)
	}
	if err := doc.deleteTopic("root"); err == nil {
		t.Fatal("中心主题不允许删除")
	}
}

// 大纲 → 文档：缩进层级要正确，第一行是中心主题。
func TestNewDocumentFromOutline(t *testing.T) {
	doc, err := newDocument("", "产品规划\n  用户研究\n    访谈\n  上线计划")
	if err != nil {
		t.Fatalf("建文档失败: %v", err)
	}
	if doc.title() != "产品规划" {
		t.Fatalf("标题应取第一行: %q", doc.title())
	}
	outline, err := doc.outline()
	if err != nil {
		t.Fatalf("大纲失败: %v", err)
	}
	if len(outline.Children) != 2 {
		t.Fatalf("应有 2 个一级分支，实际 %d", len(outline.Children))
	}
	if len(outline.Children[0].Children) != 1 || outline.Children[0].Children[0].Title != "访谈" {
		t.Fatalf("二级层级不对: %+v", outline.Children[0])
	}
	if doc.nodeCount() != 4 {
		t.Fatalf("节点数应为 4，实际 %d", doc.nodeCount())
	}
}
