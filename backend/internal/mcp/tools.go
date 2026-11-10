package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/woliubang256/wmind/backend/internal/domain"
	"github.com/woliubang256/wmind/backend/internal/service"
)

// toolDefinition 是 tools/list 里的一项。
type toolDefinition struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	InputSchema map[string]any `json:"inputSchema"`
}

// toolDefinitions 返回全部工具。
//
// 描述写给**模型**看：说清每个工具做什么、参数是什么、uid 从哪来。
func toolDefinitions() []toolDefinition {
	mapUID := map[string]any{
		"type":        "string",
		"description": "导图 uid，来自 list_maps 的返回结果",
	}
	topicID := map[string]any{
		"type":        "string",
		"description": "主题 id，来自 get_map 返回的树（中心主题的 id 也能用）",
	}
	return []toolDefinition{
		{
			Name:        "list_maps",
			Description: "列出当前账号的导图（可按关键字搜索）。返回每张图的 uid、标题、主题数、更新时间。",
			InputSchema: object(map[string]any{
				"query": map[string]any{"type": "string", "description": "可选，按标题关键字过滤"},
				"limit": map[string]any{"type": "integer", "description": "最多返回多少张，默认 20，上限 100"},
			}, nil),
		},
		{
			Name:        "get_map",
			Description: "读取一张导图的完整结构（嵌套的主题树，每个节点带 id 与标题）。修改前先用它拿到 uid 与主题 id。",
			InputSchema: object(map[string]any{"uid": mapUID}, []string{"uid"}),
		},
		{
			Name: "create_map",
			Description: "新建一张导图。outline 用缩进表示层级（两个空格或一个制表符一层），" +
				"第一行是中心主题，例如：\n产品规划\n  用户研究\n    访谈用户\n  上线计划",
			InputSchema: object(map[string]any{
				"title":   map[string]any{"type": "string", "description": "导图标题；留空则用大纲第一行"},
				"outline": map[string]any{"type": "string", "description": "缩进大纲文本"},
			}, []string{"outline"}),
		},
		{
			Name:        "update_map_title",
			Description: "修改导图标题（同时更新中心主题的文字）。",
			InputSchema: object(map[string]any{"uid": mapUID, "title": map[string]any{"type": "string", "description": "新标题"}}, []string{"uid", "title"}),
		},
		{
			Name:        "add_topic",
			Description: "在指定主题下新增一个子主题，返回新主题的 id。",
			InputSchema: object(map[string]any{
				"uid":       mapUID,
				"parent_id": map[string]any{"type": "string", "description": "父主题 id；留空表示中心主题"},
				"title":     map[string]any{"type": "string", "description": "新主题的文字"},
			}, []string{"uid", "title"}),
		},
		{
			Name:        "update_topic",
			Description: "修改任意主题的文字（含中心主题）。",
			InputSchema: object(map[string]any{
				"uid":      mapUID,
				"topic_id": topicID,
				"title":    map[string]any{"type": "string", "description": "新的文字"},
			}, []string{"uid", "topic_id", "title"}),
		},
		{
			Name:        "delete_topic",
			Description: "删除一个主题及其整棵子树。中心主题不能删除。",
			InputSchema: object(map[string]any{"uid": mapUID, "topic_id": topicID}, []string{"uid", "topic_id"}),
		},
	}
}

// object 生成一个 object 类型的 inputSchema。
func object(properties map[string]any, required []string) map[string]any {
	schema := map[string]any{"type": "object", "properties": properties}
	if len(required) > 0 {
		schema["required"] = required
	}
	return schema
}

// runTool 执行工具，返回给模型的文本。
func (s *server) runTool(ctx context.Context, owner int64, name string, args map[string]any) (string, error) {
	switch name {
	case "list_maps":
		return s.listMaps(ctx, owner, args)
	case "get_map":
		return s.getMap(ctx, owner, args)
	case "create_map":
		return s.createMap(ctx, owner, args)
	case "update_map_title":
		return s.updateMapTitle(ctx, owner, args)
	case "add_topic":
		return s.addTopic(ctx, owner, args)
	case "update_topic":
		return s.updateTopic(ctx, owner, args)
	case "delete_topic":
		return s.deleteTopic(ctx, owner, args)
	default:
		return "", fmt.Errorf("%w: %s", errUnknownTool, name)
	}
}

// argString 读取字符串参数。
func argString(args map[string]any, key string) string {
	value, _ := args[key].(string)
	return strings.TrimSpace(value)
}

// argInt 读取整数参数（JSON 里可能是 float64 或 json.Number）。
func argInt(args map[string]any, key string, fallback int) int {
	switch value := args[key].(type) {
	case float64:
		return int(value)
	case json.Number:
		if parsed, err := value.Int64(); err == nil {
			return int(parsed)
		}
	}
	return fallback
}

func (s *server) listMaps(ctx context.Context, owner int64, args map[string]any) (string, error) {
	limit := argInt(args, "limit", 20)
	if limit <= 0 || limit > 100 {
		limit = 20
	}
	maps, total, err := s.deps.Maps.List(ctx, owner, argString(args, "query"), domain.MapSortUpdated, 1, limit)
	if err != nil {
		return "", err
	}
	if len(maps) == 0 {
		return "没有找到导图。", nil
	}
	var builder strings.Builder
	fmt.Fprintf(&builder, "共 %d 张导图，返回最近更新的 %d 张：\n", total, len(maps))
	for _, item := range maps {
		fmt.Fprintf(&builder, "- %s（uid: %s，%d 个主题，更新于 %s）\n",
			item.Title, item.UID, item.NodeCount, item.UpdatedAt.Format("2006-01-02 15:04"))
	}
	return builder.String(), nil
}

func (s *server) getMap(ctx context.Context, owner int64, args map[string]any) (string, error) {
	uid := argString(args, "uid")
	if uid == "" {
		return "", fmt.Errorf("缺少参数 uid")
	}
	found, err := s.deps.Maps.Get(ctx, uid, owner)
	if err != nil {
		return "", err
	}
	doc, err := parseDocument(found.Document)
	if err != nil {
		return "", err
	}
	outline, err := doc.outline()
	if err != nil {
		return "", err
	}
	payload, err := json.MarshalIndent(map[string]any{
		"uid":     found.UID,
		"title":   found.Title,
		"version": found.Version,
		"outline": outline,
	}, "", "  ")
	if err != nil {
		return "", err
	}
	return string(payload), nil
}

func (s *server) createMap(ctx context.Context, owner int64, args map[string]any) (string, error) {
	doc, err := newDocument(argString(args, "title"), argString(args, "outline"))
	if err != nil {
		return "", err
	}
	raw, err := doc.bytes()
	if err != nil {
		return "", err
	}
	created, err := s.deps.Maps.Create(ctx, owner, service.CreateMapInput{
		Title: doc.title(), Document: raw, OwnerID: owner,
	})
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("已创建导图「%s」，uid: %s（%d 个主题）。", created.Title, created.UID, doc.nodeCount()), nil
}

// mutate 读取、修改并保存一张导图。
//
// 保存用**读到的版本号**做乐观锁：期间若有人在网页或客户端改过这张图，
// 保存会失败并提示重试，而不是静默覆盖别人的修改。
func (s *server) mutate(ctx context.Context, owner int64, uid string, edit func(doc *document) (string, error)) (string, error) {
	found, err := s.deps.Maps.Get(ctx, uid, owner)
	if err != nil {
		return "", err
	}
	doc, err := parseDocument(found.Document)
	if err != nil {
		return "", err
	}
	message, err := edit(doc)
	if err != nil {
		return "", err
	}
	raw, err := doc.bytes()
	if err != nil {
		return "", err
	}
	title := doc.title()
	if title == "" {
		title = found.Title
	}
	if _, err := s.deps.Maps.Save(ctx, uid, owner, service.SaveMapInput{
		Version: found.Version, Title: title, Document: raw,
	}); err != nil {
		return "", fmt.Errorf("%w（若提示版本冲突，请重新读取后再试）", err)
	}
	return message, nil
}

func (s *server) updateMapTitle(ctx context.Context, owner int64, args map[string]any) (string, error) {
	uid, title := argString(args, "uid"), argString(args, "title")
	if uid == "" || title == "" {
		return "", fmt.Errorf("缺少参数 uid 或 title")
	}
	return s.mutate(ctx, owner, uid, func(doc *document) (string, error) {
		root, err := doc.rootTopic()
		if err != nil {
			return "", err
		}
		if err := doc.renameTopic(topicID(root), title); err != nil {
			return "", err
		}
		return fmt.Sprintf("已把导图标题改为「%s」。", title), nil
	})
}

func (s *server) addTopic(ctx context.Context, owner int64, args map[string]any) (string, error) {
	uid, title := argString(args, "uid"), argString(args, "title")
	if uid == "" || title == "" {
		return "", fmt.Errorf("缺少参数 uid 或 title")
	}
	parent := argString(args, "parent_id")
	return s.mutate(ctx, owner, uid, func(doc *document) (string, error) {
		newID, err := doc.addChild(parent, title)
		if err != nil {
			return "", err
		}
		return fmt.Sprintf("已新增主题「%s」，id: %s。", title, newID), nil
	})
}

func (s *server) updateTopic(ctx context.Context, owner int64, args map[string]any) (string, error) {
	uid, topicIDValue, title := argString(args, "uid"), argString(args, "topic_id"), argString(args, "title")
	if uid == "" || topicIDValue == "" || title == "" {
		return "", fmt.Errorf("缺少参数 uid、topic_id 或 title")
	}
	return s.mutate(ctx, owner, uid, func(doc *document) (string, error) {
		if err := doc.renameTopic(topicIDValue, title); err != nil {
			return "", err
		}
		return fmt.Sprintf("已把主题 %s 的文字改为「%s」。", topicIDValue, title), nil
	})
}

func (s *server) deleteTopic(ctx context.Context, owner int64, args map[string]any) (string, error) {
	uid, topicIDValue := argString(args, "uid"), argString(args, "topic_id")
	if uid == "" || topicIDValue == "" {
		return "", fmt.Errorf("缺少参数 uid 或 topic_id")
	}
	return s.mutate(ctx, owner, uid, func(doc *document) (string, error) {
		if err := doc.deleteTopic(topicIDValue); err != nil {
			return "", err
		}
		return fmt.Sprintf("已删除主题 %s 及其子主题。", topicIDValue), nil
	})
}
