package service

import (
	"bytes"
	"encoding/json"
	"fmt"
)

// stripShareDocument 在服务端剥离备注与内部字段。
//
// 为什么必须在服务端做：`showNotes = false` 如果只靠前端隐藏，备注仍然在
// 响应体里，任何一个会用开发者工具的人都能看到——那不是「不显示备注」，
// 那是「显示备注但藏起来」。docs/04 §5.7 把这一条写成了硬要求。
//
// 剥离的字段：
//
//   - `notes`（任意层级）：主题备注，只在 showNotes = true 时保留。
//   - `extensions`（任意层级）：XMind 往返保真用的原始片段，与渲染无关，
//     且可能包含外部文件路径等内部信息。
//   - `meta.app`：写入端标识，分享页用不到。
//
// 用 json.Number 解析而不是默认的 float64：默认解析会把大整数变成浮点，
// 例如节点宽度 16777217 会回写成 16777216。这条路径要原样搬运转发，不能
// 在途中改变数值。
//
// 递归深度由 encoding/json 自己兜底（超过 10000 层直接返回错误），而
// Go 的栈是按需增长的，所以这里不需要额外的深度参数——与 countNodes 不同，
// 那个函数遍历的是已经解析好的树，深度只受文档内容限制。
func stripShareDocument(raw []byte, showNotes bool) ([]byte, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var root any
	if err := dec.Decode(&root); err != nil {
		return nil, fmt.Errorf("解析待分享文档: %w", err)
	}
	obj, ok := root.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("待分享文档不是 JSON 对象")
	}
	stripShareNode(obj, showNotes)
	if meta, ok := obj["meta"].(map[string]any); ok {
		delete(meta, "app")
	}
	out, err := json.Marshal(obj)
	if err != nil {
		return nil, fmt.Errorf("序列化待分享文档: %w", err)
	}
	return out, nil
}

// stripShareNode 递归剥离一个 JSON 节点。
func stripShareNode(node any, showNotes bool) {
	switch v := node.(type) {
	case map[string]any:
		if !showNotes {
			delete(v, "notes")
		}
		delete(v, "extensions")
		for _, child := range v {
			stripShareNode(child, showNotes)
		}
	case []any:
		for _, child := range v {
			stripShareNode(child, showNotes)
		}
	}
}
