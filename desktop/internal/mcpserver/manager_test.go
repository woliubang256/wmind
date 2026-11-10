package mcpserver

import (
	"context"
	"io"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"
)

// freePort 借一个端口再立刻释放：测试里需要「确定空闲」的端口。
func freePort(t *testing.T) int {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("取端口失败: %v", err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	_ = listener.Close()
	return port
}

// 开启后能收到 MCP 请求，令牌不对返回 401，关掉后端口释放。
func TestManagerServesMCP(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	manager := New(nil, 1, "test", logger)
	port := freePort(t)

	if err := manager.Apply(context.Background(), true, port, "secret"); err != nil {
		t.Fatalf("启动失败: %v", err)
	}
	defer manager.Stop()
	if manager.URL() == "" {
		t.Fatal("运行中应当返回 URL")
	}

	body := `{"jsonrpc":"2.0","id":1,"method":"initialize"}`
	req, _ := http.NewRequest(http.MethodPost, manager.URL(), strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer secret")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("请求失败: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("令牌正确应 200，实际 %d", resp.StatusCode)
	}

	bad, _ := http.NewRequest(http.MethodPost, manager.URL(), strings.NewReader(body))
	bad.Header.Set("Authorization", "Bearer wrong")
	resp2, err := http.DefaultClient.Do(bad)
	if err != nil {
		t.Fatalf("请求失败: %v", err)
	}
	defer resp2.Body.Close()
	if resp2.StatusCode != http.StatusUnauthorized {
		t.Fatalf("令牌错误应 401，实际 %d", resp2.StatusCode)
	}

	manager.Stop()
	if manager.URL() != "" {
		t.Fatal("停止后不该再有 URL")
	}
	// 端口应当已经释放，可以重新监听。
	listener, err := net.Listen("tcp", "127.0.0.1:"+itoa(port))
	if err != nil {
		t.Fatalf("停止后端口没释放: %v", err)
	}
	_ = listener.Close()
	time.Sleep(10 * time.Millisecond)
}

func itoa(value int) string {
	if value == 0 {
		return "0"
	}
	var digits []byte
	for value > 0 {
		digits = append([]byte{byte('0' + value%10)}, digits...)
		value /= 10
	}
	return string(digits)
}
