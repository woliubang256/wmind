// Package mcp 提供一个极简的 MCP（Model Context Protocol）服务器：让 AI 客户端
// 通过 HTTP 查询、创建和修改导图。
//
// 传输是 JSON-RPC 2.0 over HTTP（POST /mcp），不引第三方 SDK——用到的只有
// initialize / tools/list / tools/call 三个方法，几十行就能说清楚，引一个依赖
// 反而要跟着它的协议版本走。
//
// 这个文件只做「文档」这一层：把 .wmind 的 JSON 读成可遍历的结构、改完再写回。
// **必须无损**：AI 只改标题，其余字段（样式、备注、标记、图片……）一个都不能丢，
// 所以这里全程用 map[string]any + json.Number 处理，不定义会吃掉未知字段的
// 强类型结构。
package mcp

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/woliubang256/wmind/backend/internal/pkg/id"
)

// ErrNotFound 表示文档里找不到指定的主题或画布。
var ErrNotFound = errors.New("mcp: not found")

// document 是一份 .wmind 文档的可变视图。
type document struct {
	root map[string]any
}

// parseDocument 解析文档 JSON。
func parseDocument(raw []byte) (*document, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	// UseNumber 保留数字的字面形式：否则 1 会被编码回 1（还好），但大整数会
	// 丢精度，而文档里确实有版本号之类的数字字段。
	decoder.UseNumber()
	var root map[string]any
	if err := decoder.Decode(&root); err != nil {
		return nil, fmt.Errorf("mcp: parse document: %w", err)
	}
	if _, ok := root["sheets"]; !ok {
		return nil, errors.New("mcp: document has no sheets")
	}
	return &document{root: root}, nil
}

// bytes 把文档编码回 JSON。
func (d *document) bytes() ([]byte, error) {
	return json.Marshal(d.root)
}

// title 是文档标题。
func (d *document) title() string {
	value, _ := d.root["title"].(string)
	return value
}

// firstSheet 返回第一张画布（MCP 的工具都作用于首张画布，多画布暂不暴露）。
func (d *document) firstSheet() (map[string]any, error) {
	sheets, ok := d.root["sheets"].([]any)
	if !ok || len(sheets) == 0 {
		return nil, errors.New("mcp: document has no sheets")
	}
	sheet, ok := sheets[0].(map[string]any)
	if !ok {
		return nil, errors.New("mcp: sheet is not an object")
	}
	return sheet, nil
}

// rootTopic 返回首张画布的中心主题。
func (d *document) rootTopic() (map[string]any, error) {
	sheet, err := d.firstSheet()
	if err != nil {
		return nil, err
	}
	topic, ok := sheet["rootTopic"].(map[string]any)
	if !ok {
		return nil, errors.New("mcp: sheet has no rootTopic")
	}
	return topic, nil
}

// children 返回主题的子主题列表（attached 与 detached 合并，detached 在后）。
func children(topic map[string]any) []any {
	holder, ok := topic["children"].(map[string]any)
	if !ok {
		return nil
	}
	out := make([]any, 0, 4)
	if attached, ok := holder["attached"].([]any); ok {
		out = append(out, attached...)
	}
	if detached, ok := holder["detached"].([]any); ok {
		out = append(out, detached...)
	}
	return out
}

// attachChild 把一个新主题挂到 parent 下（写入 attached 数组）。
func attachChild(parent map[string]any, child map[string]any) {
	holder, ok := parent["children"].(map[string]any)
	if !ok {
		holder = map[string]any{}
		parent["children"] = holder
	}
	attached, ok := holder["attached"].([]any)
	if !ok {
		attached = []any{}
	}
	holder["attached"] = append(attached, child)
}

// topicID 返回主题 id。
func topicID(topic map[string]any) string {
	value, _ := topic["id"].(string)
	return value
}

// topicTitle 返回主题标题。
func topicTitle(topic map[string]any) string {
	value, _ := topic["title"].(string)
	return value
}

// findTopic 按 id 查找主题，返回主题本身、父主题与它在父级列表里的下标。
func (d *document) findTopic(topicID string) (map[string]any, map[string]any, []any, int, error) {
	root, err := d.rootTopic()
	if err != nil {
		return nil, nil, nil, -1, err
	}
	if topicID == "" {
		return root, nil, nil, -1, nil
	}
	if topicIDOf(root) == topicID {
		return root, nil, nil, -1, nil
	}
	var found map[string]any
	var parent map[string]any
	var siblings []any
	index := -1
	var walk func(node map[string]any)
	walk = func(node map[string]any) {
		if found != nil {
			return
		}
		kids := children(node)
		for position, raw := range kids {
			kid, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			if topicIDOf(kid) == topicID {
				found, parent, siblings, index = kid, node, kids, position
				return
			}
			walk(kid)
			if found != nil {
				return
			}
		}
	}
	walk(root)
	if found == nil {
		return nil, nil, nil, -1, ErrNotFound
	}
	return found, parent, siblings, index, nil
}

// topicIDOf 是 topicID 的别名，避免与局部变量同名时读起来别扭。
func topicIDOf(topic map[string]any) string { return topicID(topic) }

// addChild 在 parentID 下新增一个子主题，返回新主题 id。
func (d *document) addChild(parentID, title string) (string, error) {
	parent, _, _, _, err := d.findTopic(parentID)
	if err != nil {
		return "", err
	}
	uid := id.New()
	attachChild(parent, map[string]any{
		"id":    uid,
		"title": title,
		"children": map[string]any{
			"attached": []any{},
		},
	})
	return uid, nil
}

// renameTopic 改主题标题。中心主题同时改文档标题，保持列表与画布一致。
func (d *document) renameTopic(topicIDValue, title string) error {
	topic, parent, _, _, err := d.findTopic(topicIDValue)
	if err != nil {
		return err
	}
	topic["title"] = title
	if parent == nil {
		d.root["title"] = title
	}
	return nil
}

// deleteTopic 删除主题及其整棵子树。中心主题不允许删除。
func (d *document) deleteTopic(topicIDValue string) error {
	topic, parent, siblings, index, err := d.findTopic(topicIDValue)
	if err != nil {
		return err
	}
	if parent == nil {
		return errors.New("mcp: 不能删除中心主题")
	}
	_ = topic
	// 从父级的 attached/detached 里摘掉：siblings 是合并视图，需要回到原数组。
	holder, _ := parent["children"].(map[string]any)
	for _, key := range []string{"attached", "detached"} {
		list, ok := holder[key].([]any)
		if !ok {
			continue
		}
		for position, raw := range list {
			if kid, ok := raw.(map[string]any); ok && topicIDOf(kid) == topicIDValue {
				holder[key] = append(append([]any{}, list[:position]...), list[position+1:]...)
				return nil
			}
		}
	}
	_ = siblings
	_ = index
	return ErrNotFound
}

// nodeCount 统计主题总数（含中心主题），与前端保存时写的 nodeCount 口径一致。
func (d *document) nodeCount() int {
	root, err := d.rootTopic()
	if err != nil {
		return 0
	}
	var count func(topic map[string]any) int
	count = func(topic map[string]any) int {
		total := 1
		for _, raw := range children(topic) {
			if kid, ok := raw.(map[string]any); ok {
				total += count(kid)
			}
		}
		return total
	}
	return count(root)
}

// outlineNode 是 get_map 返回给 AI 的树结构。
type outlineNode struct {
	ID       string        `json:"id"`
	Title    string        `json:"title"`
	Children []outlineNode `json:"children,omitempty"`
}

// outline 把首张画布转成嵌套结构。
func (d *document) outline() (outlineNode, error) {
	root, err := d.rootTopic()
	if err != nil {
		return outlineNode{}, err
	}
	var build func(topic map[string]any) outlineNode
	build = func(topic map[string]any) outlineNode {
		node := outlineNode{ID: topicID(topic), Title: topicTitle(topic)}
		for _, raw := range children(topic) {
			if kid, ok := raw.(map[string]any); ok {
				node.Children = append(node.Children, build(kid))
			}
		}
		return node
	}
	return build(root), nil
}

// newDocument 从缩进大纲建一份新文档。
//
// outline 的每一行是一个主题，用**两个空格或一个制表符**表示层级，例如：
//
//	产品规划
//	  用户研究
//	    访谈 12 位用户
//	  上线计划
//
// 第一行是中心主题（也是文档标题）。
func newDocument(title, outline string) (*document, error) {
	lines := parseOutline(outline)
	if len(lines) == 0 {
		return nil, errors.New("mcp: outline 为空")
	}
	if title == "" {
		title = lines[0].text
	}
	// 第一行若不是最外层（深度 > 0），把它当作中心主题并整体左移。
	base := lines[0].depth
	type frame struct {
		topic map[string]any
		depth int
	}
	rootTopic := map[string]any{
		"id":       id.New(),
		"title":    lines[0].text,
		"children": map[string]any{"attached": []any{}},
	}
	stack := []frame{{topic: rootTopic, depth: base}}
	for _, line := range lines[1:] {
		topic := map[string]any{
			"id":       id.New(),
			"title":    line.text,
			"children": map[string]any{"attached": []any{}},
		}
		for len(stack) > 0 && line.depth <= stack[len(stack)-1].depth {
			stack = stack[:len(stack)-1]
		}
		parent := rootTopic
		if len(stack) > 0 {
			parent = stack[len(stack)-1].topic
		}
		attachChild(parent, topic)
		stack = append(stack, frame{topic: topic, depth: line.depth})
	}

	doc := map[string]any{
		"format":        "wmind",
		"formatVersion": "1.0",
		"id":            id.New(),
		"title":         title,
		"sheets": []any{map[string]any{
			"id":        id.New(),
			"title":     title,
			"rootTopic": rootTopic,
		}},
	}
	return &document{root: doc}, nil
}

// outlineLine 是大纲里的一行。
type outlineLine struct {
	depth int
	text  string
}

// parseOutline 解析缩进大纲，忽略空行与 `#` 注释行。
func parseOutline(outline string) []outlineLine {
	var lines []outlineLine
	for _, raw := range strings.Split(outline, "\n") {
		trimmed := strings.TrimRight(raw, " \r")
		if strings.TrimSpace(trimmed) == "" {
			continue
		}
		if strings.HasPrefix(strings.TrimSpace(trimmed), "#") {
			continue
		}
		depth := 0
		for _, char := range trimmed {
			switch char {
			case ' ':
				depth++
			case '\t':
				depth += 2
			default:
				lines = append(lines, outlineLine{depth: depth / 2, text: strings.TrimSpace(trimmed)})
				goto next
			}
		}
	next:
	}
	return lines
}
