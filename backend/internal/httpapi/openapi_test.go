package httpapi_test

import (
	"os"
	"sort"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"go.yaml.in/yaml/v3"
)

// OpenAPI 与真实路由的对等性。
//
// 这份文档最容易坏的方式是**悄悄过期**：加了一个接口忘了写进 yaml，或者删了
// 一个接口但 yaml 里还留着。两种都不会报错，只会在某天有人照着文档写客户端
// 时才发现。所以这里做三件事：
//
//  1. 路由表里有的，yaml 里必须有；yaml 里有的，路由表里必须有；
//  2. yaml 里每个 `#/components/...` 引用都能解析到——拼错一个字母，
//     生成器会在客户端那侧才炸；
//  3. 每个 path 都在 `/api/v1` 下，不带查询串。
//
// 静态文件路由（`/uploads/*filepath`）不算 API：它由静态中间件直接回文件，
// 不进信封、不参与版本化。

const specPath = "../../../docs/openapi.yaml"

// apiOperationCount 是 OpenAPI 文档里声明的接口数量（不含 `/uploads/*filepath`）。
//
// 钉住它是为了让「加了接口忘了改文档」多一道拦网：真加了一个接口，改这个
// 常量时手会停一下，多半就会顺手去更新 docs/04 §5 与 docs/openapi.yaml。
const apiOperationCount = 62

// notAPI 是不进 OpenAPI 的路由。
var notAPI = map[string]bool{
	"/uploads/*filepath": true,
}

// httpVerbs 是 OpenAPI 里表示操作的键。同一个 path 下还有 `parameters`、
// `summary` 这类非操作键，要按白名单挑。
var httpVerbs = map[string]bool{
	"get": true, "put": true, "post": true, "delete": true,
	"options": true, "head": true, "patch": true, "trace": true,
}

func TestOpenAPIMatchesRouter(t *testing.T) {
	raw, err := os.ReadFile(specPath)
	if err != nil {
		t.Fatalf("读 OpenAPI 文档: %v", err)
	}
	var doc map[string]any
	if err := yaml.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("解析 %s: %v", specPath, err)
	}

	server := newAuthTestServer(t)
	engine, ok := server.router.(*gin.Engine)
	if !ok {
		t.Fatalf("路由不是 *gin.Engine，而是 %T", server.router)
	}

	routes := make(map[string]bool)
	for _, route := range engine.Routes() {
		if notAPI[route.Path] {
			continue
		}
		routes[route.Method+" "+ginPathToOpenAPI(route.Path)] = true
	}

	paths, ok := doc["paths"].(map[string]any)
	if !ok {
		t.Fatal("OpenAPI 文档缺少 paths")
	}
	spec := make(map[string]bool)
	for path, item := range paths {
		if !strings.HasPrefix(path, "/api/v1/") {
			t.Errorf("path 不在 /api/v1 下: %s", path)
		}
		if strings.ContainsAny(path, "?") {
			t.Errorf("path 不应带查询串: %s", path)
		}
		operations, ok := item.(map[string]any)
		if !ok {
			t.Errorf("%s 的节点不是对象", path)
			continue
		}
		for key := range operations {
			if httpVerbs[strings.ToLower(key)] {
				spec[strings.ToUpper(key)+" "+path] = true
			}
		}
	}

	for op := range routes {
		if !spec[op] {
			t.Errorf("路由表有、OpenAPI 没有：%s", op)
		}
	}
	for op := range spec {
		if !routes[op] {
			t.Errorf("OpenAPI 有、路由表没有：%s", op)
		}
	}

	if len(spec) != apiOperationCount {
		t.Errorf("接口数量变成 %d（文档声明 %d）：更新 docs/04 §5、docs/openapi.yaml 与本处常量",
			len(spec), apiOperationCount)
	}
}

// ginPathToOpenAPI 把 gin 的 `:param` / `*param` 换成 OpenAPI 的 `{param}`。
//
// 两边的路径参数语法天生不同，直接比对会让每一条带参数的接口都报「缺一个、
// 多一个」，把真正的差异淹掉。
func ginPathToOpenAPI(path string) string {
	segments := strings.Split(path, "/")
	for i, segment := range segments {
		if len(segment) > 1 && (segment[0] == ':' || segment[0] == '*') {
			segments[i] = "{" + segment[1:] + "}"
		}
	}
	return strings.Join(segments, "/")
}

// TestOpenAPIReferencesResolve 检查每个组件引用都能解析。
//
// 拼错一个 `$ref` 在 YAML 里完全合法，只有真正生成代码或渲染文档时才会炸，
// 而那时通常已经离改动很远了。
func TestOpenAPIReferencesResolve(t *testing.T) {
	raw, err := os.ReadFile(specPath)
	if err != nil {
		t.Fatalf("读 OpenAPI 文档: %v", err)
	}
	var root yaml.Node
	if err := yaml.Unmarshal(raw, &root); err != nil {
		t.Fatalf("解析 %s: %v", specPath, err)
	}

	var doc map[string]any
	if err := yaml.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("解析 %s: %v", specPath, err)
	}
	known := componentRefs(doc)

	var missing []string
	walkRefs(&root, func(ref string) {
		if !strings.HasPrefix(ref, "#/") {
			// 外部文件引用：本仓库没有用到，出现了就是需要人来判断的信号。
			missing = append(missing, ref+"（外部引用未支持）")
			return
		}
		if !known[ref] {
			missing = append(missing, ref)
		}
	})
	sort.Strings(missing)
	for _, ref := range missing {
		t.Errorf("无法解析的引用: %s", ref)
	}
}

// componentRefs 收集 `#/components/<组>/<名字>` 形式的全部合法引用。
func componentRefs(doc map[string]any) map[string]bool {
	known := make(map[string]bool)
	components, ok := doc["components"].(map[string]any)
	if !ok {
		return known
	}
	for group, value := range components {
		entries, ok := value.(map[string]any)
		if !ok {
			continue
		}
		for name := range entries {
			known["#/components/"+group+"/"+name] = true
		}
	}
	return known
}

// walkRefs 深度遍历 YAML 树，把每个 `$ref` 的值交给 visit。
func walkRefs(node *yaml.Node, visit func(string)) {
	if node == nil {
		return
	}
	if node.Kind == yaml.MappingNode {
		for i := 0; i+1 < len(node.Content); i += 2 {
			key, value := node.Content[i], node.Content[i+1]
			if key.Value == "$ref" && value.Kind == yaml.ScalarNode {
				visit(value.Value)
				continue
			}
			walkRefs(value, visit)
		}
		return
	}
	for _, child := range node.Content {
		walkRefs(child, visit)
	}
}
