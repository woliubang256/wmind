package deskapi

import (
	"context"
	"net/http"
	"testing"
)

// 本地 MCP 的开关/端口/密钥通过 /desktop/mcp 读写，并在开启时启动监听。
func TestMCPToggleStartsServer(t *testing.T) {
	f := newFixture(t)

	status := dataOf(t, f.do(t, http.MethodGet, "/desktop/mcp", nil))
	if status["enabled"] != false {
		t.Fatalf("默认应当是关闭的: %#v", status)
	}

	port := 17801
	resp := f.do(t, http.MethodPut, "/desktop/mcp", map[string]any{"enabled": true, "port": port})
	if resp.status != http.StatusOK {
		t.Fatalf("开启失败 = %d %s", resp.status, string(resp.Data))
	}
	enabled := dataOf(t, resp)
	token, _ := enabled["token"].(string)
	if token == "" {
		t.Fatal("开启时应自动生成密钥")
	}
	if enabled["enabled"] != true {
		t.Fatalf("应当已开启: %#v", enabled)
	}

	// 关闭后端口释放
	resp = f.do(t, http.MethodPut, "/desktop/mcp", map[string]any{"enabled": false})
	if resp.status != http.StatusOK || dataOf(t, resp)["enabled"] != false {
		t.Fatalf("关闭失败 = %d %s", resp.status, string(resp.Data))
	}
}

// 默认传输是 stdio：开启后不该占端口（由客户端按需拉起子进程）。
func TestMCPStdioDoesNotListen(t *testing.T) {
	f := newFixture(t)
	status := dataOf(t, f.do(t, http.MethodGet, "/desktop/mcp", nil))
	if status["transport"] != "stdio" {
		t.Fatalf("默认传输应当是 stdio: %#v", status)
	}
	resp := f.do(t, http.MethodPut, "/desktop/mcp", map[string]any{"enabled": true, "port": 17803})
	if resp.status != http.StatusOK {
		t.Fatalf("开启失败 = %d %s", resp.status, string(resp.Data))
	}
	if f.mcp.running {
		t.Fatal("stdio 传输不该启动本地监听")
	}
	if dataOf(t, resp)["enabled"] != true {
		t.Fatalf("设置里应当是开启状态: %#v", dataOf(t, resp))
	}

	// 切到 http 才监听
	resp = f.do(t, http.MethodPut, "/desktop/mcp", map[string]any{"enabled": true, "transport": "http", "port": 17804})
	if resp.status != http.StatusOK {
		t.Fatalf("切到 http 失败 = %d %s", resp.status, string(resp.Data))
	}
	if !f.mcp.running || f.mcp.port != 17804 {
		t.Fatalf("http 传输应当监听端口: %+v", f.mcp)
	}
}

// 重新生成密钥会换掉旧值。
func TestMCPRegenerateToken(t *testing.T) {
	f := newFixture(t)
	port := 17802
	first := dataOf(t, f.do(t, http.MethodPut, "/desktop/mcp", map[string]any{"enabled": true, "transport": "http", "port": port}))
	firstToken, _ := first["token"].(string)
	second := dataOf(t, f.do(t, http.MethodPut, "/desktop/mcp", map[string]any{"regenerate": true}))
	secondToken, _ := second["token"].(string)
	if firstToken == "" || secondToken == "" || firstToken == secondToken {
		t.Fatalf("密钥没有重新生成: %q → %q", firstToken, secondToken)
	}
}

// 设置服务里的快照要能读到刚写入的值。
func TestMCPStatusReflectsSettings(t *testing.T) {
	f := newFixture(t)
	if _, err := f.settings.Update(context.Background(), map[string]any{"mcp.port": 8123}, nil); err != nil {
		t.Fatalf("写入设置失败: %v", err)
	}
	status := dataOf(t, f.do(t, http.MethodGet, "/desktop/mcp", nil))
	if status["port"] != float64(8123) {
		t.Fatalf("端口没读到: %#v", status)
	}
}
