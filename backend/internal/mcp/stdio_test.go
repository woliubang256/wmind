package mcp

import (
	"bytes"
	"context"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/woliubang256/wmind/backend/internal/domain"
)

// stdio 传输：逐行 JSON-RPC，响应逐行写回；EOF 结束。
func TestServeStdio(t *testing.T) {
	maps := newFakeMaps()
	maps.rows["map-1"] = &domain.Map{
		UID: "map-1", OwnerID: 7, Title: "产品规划", Version: 1,
		Document: []byte(sampleDoc), UpdatedAt: time.Now(),
	}
	input := strings.Join([]string{
		`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}`,
		`{"jsonrpc":"2.0","method":"notifications/initialized"}`,
		`{"jsonrpc":"2.0","id":2,"method":"tools/list"}`,
		`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_maps","arguments":{}}}`,
	}, "\n") + "\n"

	var out bytes.Buffer
	deps := Deps{
		Maps:    maps,
		Version: "test",
		Owner:   func(context.Context) (int64, error) { return 7, nil },
	}
	if err := ServeStdio(context.Background(), deps, strings.NewReader(input), &out, slog.New(slog.NewTextHandler(io.Discard, nil))); err != nil {
		t.Fatalf("stdio 运行失败: %v", err)
	}
	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	// 通知不产生响应：三条请求 → 三行
	if len(lines) != 3 {
		t.Fatalf("响应行数应为 3，实际 %d：%s", len(lines), out.String())
	}
	if !strings.Contains(lines[0], "protocolVersion") {
		t.Fatalf("第一行不是 initialize 结果: %s", lines[0])
	}
	if !strings.Contains(lines[1], "list_maps") {
		t.Fatalf("第二行不是 tools/list: %s", lines[1])
	}
	if !strings.Contains(lines[2], "产品规划") {
		t.Fatalf("第三行不是 list_maps 结果: %s", lines[2])
	}
}

// 非法 JSON 回一条错误响应，进程继续读下一行。
func TestServeStdioRecoversFromBadLine(t *testing.T) {
	var out bytes.Buffer
	deps := Deps{
		Maps:    newFakeMaps(),
		Version: "test",
		Owner:   func(context.Context) (int64, error) { return 7, nil },
	}
	input := "not json\n" + `{"jsonrpc":"2.0","id":9,"method":"ping"}` + "\n"
	if err := ServeStdio(context.Background(), deps, strings.NewReader(input), &out, nil); err != nil {
		t.Fatalf("运行失败: %v", err)
	}
	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	if len(lines) != 2 || !strings.Contains(lines[0], "invalid JSON-RPC request") {
		t.Fatalf("应当先回错误再继续: %s", out.String())
	}
}
