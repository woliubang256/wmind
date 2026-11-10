package mcp

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"

	"github.com/woliubang256/wmind/backend/internal/domain"
	"github.com/woliubang256/wmind/backend/internal/service"
)

// ProtocolVersion 是服务器默认声明的 MCP 协议版本。
//
// 客户端在 initialize 里会带自己支持的版本；我们原样回声（MCP 允许服务端
// 选择客户端给出的版本），没带时才用这个默认值。
const ProtocolVersion = "2025-06-18"

// maxRequestBytes 是单次 JSON-RPC 请求的上限：工具参数都很小。
const maxRequestBytes = 1 << 20

// Maps 是工具需要的导图能力。
//
// 用接口而不是直接依赖 *service.MapService：这个包只关心「读一张、改一张、
// 建一张」，测试里给一个内存实现就能覆盖全部工具。
type Maps interface {
	List(ctx context.Context, ownerID int64, keyword string, sort domain.MapSort, page, pageSize int) ([]*domain.Map, int64, error)
	Get(ctx context.Context, uid string, ownerID int64) (*domain.Map, error)
	Create(ctx context.Context, ownerID int64, in service.CreateMapInput) (*domain.Map, error)
	Save(ctx context.Context, uid string, ownerID int64, in service.SaveMapInput) (*domain.Map, error)
}

// Deps 是 MCP 服务器的依赖。
type Deps struct {
	// Maps 是导图能力：工具通过它读写导图（带乐观锁与大小校验）。
	Maps Maps
	// Token 是访问令牌；空表示未开启，所有请求一律 403。
	Token string
	// Owner 把令牌解析成「以谁的身份操作」。
	//
	// 服务端：令牌属于开启 MCP 的管理员，操作范围就是他自己的导图；桌面端：
	// 永远是本机用户。两者都在装配处注入，这个包不关心身份从哪来。
	Owner func(ctx context.Context) (int64, error)
	// Version 是应用版本，写进 serverInfo。
	Version string
	Logger  *slog.Logger
	// Name 是 serverInfo 里的名字（默认 "wmind"）。
	Name string
}

// New 构造 MCP 的 HTTP 处理器（POST /mcp）。
func New(deps Deps) http.Handler {
	if deps.Name == "" {
		deps.Name = "wmind"
	}
	if deps.Logger == nil {
		deps.Logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	s := &server{deps: deps}
	return http.HandlerFunc(s.handle)
}

type server struct {
	deps Deps
}

// rpcRequest 是一条 JSON-RPC 2.0 请求。
type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}

// rpcError 是 JSON-RPC 的错误对象。
type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

// rpcResponse 是一条 JSON-RPC 2.0 响应。
type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

// 标准 JSON-RPC 错误码。
const (
	codeInvalidRequest = -32600
	codeMethodNotFound = -32601
	codeInvalidParams  = -32602
	codeInternal       = -32603
)

func (s *server) handle(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.authorized(r) {
		w.Header().Set("WWW-Authenticate", `Bearer realm="wmind"`)
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	var req rpcRequest
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxRequestBytes))
	if err := decoder.Decode(&req); err != nil {
		s.write(w, rpcResponse{JSONRPC: "2.0", Error: &rpcError{Code: codeInvalidRequest, Message: "invalid JSON-RPC request"}})
		return
	}
	// 通知（没有 id）不需要响应：客户端发完 notifications/initialized 就走。
	if len(req.ID) == 0 {
		w.WriteHeader(http.StatusAccepted)
		return
	}
	result, rpcErr := s.dispatch(r, req)
	response := rpcResponse{JSONRPC: "2.0", ID: req.ID}
	if rpcErr != nil {
		response.Error = rpcErr
	} else {
		response.Result = result
	}
	s.write(w, response)
}

// authorized 校验 Bearer 令牌。
func (s *server) authorized(r *http.Request) bool {
	if s.deps.Token == "" {
		return false
	}
	header := strings.TrimSpace(r.Header.Get("Authorization"))
	token, ok := strings.CutPrefix(header, "Bearer ")
	if !ok {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(strings.TrimSpace(token)), []byte(s.deps.Token)) == 1
}

func (s *server) write(w http.ResponseWriter, response rpcResponse) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(response)
}

// dispatch 按方法分发。
func (s *server) dispatch(r *http.Request, req rpcRequest) (any, *rpcError) {
	switch req.Method {
	case "initialize":
		return s.initialize(req.Params), nil
	case "ping":
		return map[string]any{}, nil
	case "tools/list":
		return map[string]any{"tools": toolDefinitions()}, nil
	case "tools/call":
		return s.callTool(r, req.Params)
	default:
		return nil, &rpcError{Code: codeMethodNotFound, Message: "unknown method: " + req.Method}
	}
}

// initialize 回应握手，声明只支持 tools 能力。
func (s *server) initialize(params json.RawMessage) any {
	version := ProtocolVersion
	var incoming struct {
		ProtocolVersion string `json:"protocolVersion"`
	}
	if len(params) > 0 && json.Unmarshal(params, &incoming) == nil && incoming.ProtocolVersion != "" {
		version = incoming.ProtocolVersion
	}
	return map[string]any{
		"protocolVersion": version,
		"capabilities":    map[string]any{"tools": map[string]any{"listChanged": false}},
		"serverInfo":      map[string]any{"name": s.deps.Name, "version": s.deps.Version},
	}
}

// callTool 执行一个工具调用。
func (s *server) callTool(r *http.Request, params json.RawMessage) (any, *rpcError) {
	var call struct {
		Name      string         `json:"name"`
		Arguments map[string]any `json:"arguments"`
	}
	if err := json.Unmarshal(params, &call); err != nil || call.Name == "" {
		return nil, &rpcError{Code: codeInvalidParams, Message: "tools/call 需要 name 与 arguments"}
	}
	owner, err := s.deps.Owner(r.Context())
	if err != nil {
		return nil, &rpcError{Code: codeInternal, Message: "无法确定操作身份: " + err.Error()}
	}
	text, err := s.runTool(r.Context(), owner, call.Name, call.Arguments)
	if err != nil {
		// 工具级失败按 MCP 约定放在结果里（isError），客户端能看到原因而不是
		// 把它当成协议错误。
		s.deps.Logger.Warn("mcp: tool failed", "tool", call.Name, "err", err)
		return map[string]any{
			"content": []any{map[string]any{"type": "text", "text": err.Error()}},
			"isError": true,
		}, nil
	}
	return map[string]any{
		"content": []any{map[string]any{"type": "text", "text": text}},
		"isError": false,
	}, nil
}

// errUnknownTool 在客户端调了不存在的工具时返回。
var errUnknownTool = errors.New("未知工具")
