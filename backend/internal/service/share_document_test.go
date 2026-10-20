package service

import (
	"encoding/json"
	"strings"
	"testing"
)

// decode 把剥离后的文档解回来，方便断言字段是否还在。
func decodeShareDoc(t *testing.T, raw []byte) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("剥离结果不是合法 JSON: %v（%s）", err, raw)
	}
	return out
}

const shareDocFixture = `{
  "format": "wmind",
  "formatVersion": "1.0",
  "id": "doc-1",
  "title": "产品规划",
  "meta": {"createdAt": "2026-10-21T10:00:00Z", "updatedAt": "2026-10-21T10:00:00Z", "app": "wmind/1.0"},
  "extensions": [{"internal": "top"}],
  "sheets": [{
    "id": "sh-1",
    "rootTopic": {
      "id": "root",
      "title": "中心",
      "notes": {"plain": "根备注", "html": "<p>根备注</p>"},
      "extensions": [{"internal": "topic"}],
      "width": 16777217,
      "children": {"attached": [
        {"id": "a", "title": "A", "notes": {"plain": "子备注", "html": ""}, "extensions": []},
        {"id": "b", "title": "B", "notes": {"plain": "", "html": ""}}
      ]}
    }
  }]
}`

func TestStripShareDocumentRemovesNotesWhenHidden(t *testing.T) {
	out, err := stripShareDocument([]byte(shareDocFixture), false)
	if err != nil {
		t.Fatalf("stripShareDocument: %v", err)
	}
	if strings.Contains(string(out), "备注") {
		t.Fatalf("备注没有被剥离：%s", out)
	}
	if strings.Contains(string(out), `"notes"`) {
		t.Fatalf("notes 键仍然存在：%s", out)
	}
}

func TestStripShareDocumentKeepsNotesWhenShown(t *testing.T) {
	out, err := stripShareDocument([]byte(shareDocFixture), true)
	if err != nil {
		t.Fatalf("stripShareDocument: %v", err)
	}
	if !strings.Contains(string(out), "根备注") || !strings.Contains(string(out), "子备注") {
		t.Fatalf("showNotes=true 时备注应当保留：%s", out)
	}
}

func TestStripShareDocumentAlwaysRemovesInternalFields(t *testing.T) {
	out, err := stripShareDocument([]byte(shareDocFixture), true)
	if err != nil {
		t.Fatalf("stripShareDocument: %v", err)
	}
	text := string(out)
	for _, forbidden := range []string{`"extensions"`, "wmind/1.0", "internal"} {
		if strings.Contains(text, forbidden) {
			t.Fatalf("%s 没有被剥离：%s", forbidden, text)
		}
	}
	// 渲染必需的字段必须原样留着。
	if !strings.Contains(text, `"rootTopic"`) || !strings.Contains(text, "产品规划") {
		t.Fatalf("渲染字段被误删：%s", text)
	}
}

// 数值必须原样搬运转发。
//
// 默认的 json.Unmarshal 会把所有数字变成 float64：16777217（2^24+1）在
// float64 里存不下，回写时变成 16777216——节点宽度悄悄少 1 像素，而且
// 只在特定尺寸下出现。UseNumber 就是为了这条。
func TestStripShareDocumentPreservesNumberPrecision(t *testing.T) {
	out, err := stripShareDocument([]byte(shareDocFixture), true)
	if err != nil {
		t.Fatalf("stripShareDocument: %v", err)
	}
	if !strings.Contains(string(out), "16777217") {
		t.Fatalf("大整数被改写：%s", out)
	}
}

func TestStripShareDocumentRejectsNonObjectRoot(t *testing.T) {
	if _, err := stripShareDocument([]byte(`[1,2,3]`), true); err == nil {
		t.Fatal("数组根应当被拒")
	}
	if _, err := stripShareDocument([]byte(`not json`), true); err == nil {
		t.Fatal("非法 JSON 应当被拒")
	}
}

// 空文档也不能 panic：分享一条早期数据损坏的记录时，宁可返回错误也不要
// 让整个进程挂掉。
func TestStripShareDocumentHandlesEmptyDocument(t *testing.T) {
	out, err := stripShareDocument([]byte(`{}`), false)
	if err != nil {
		t.Fatalf("空对象: %v", err)
	}
	if got := decodeShareDoc(t, out); len(got) != 0 {
		t.Fatalf("期望空对象，实际 %#v", got)
	}
}
