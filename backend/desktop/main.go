// Command desktop is wmind's desktop client entry point.
//
// 它把一个 mygo 窗口和一套本机后端进程装在一起：窗口里跑的是与 Web 完全
// 相同的前端，后端也是同一套 router（见 internal/bootstrap），数据落在
// 本机 SQLite。默认「本地模式」不需要任何账号，也完全不访问网络。
package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/egoist/mygo"

	"github.com/woliubang256/wmind/backend/desktop/internal/localserver"
)

// version 由构建时通过 -ldflags 注入（见 scripts/build-desktop.mjs），
// 未注入时退回 mygo 配置里的版本。
var version = ""

func main() {
	if err := run(); err != nil {
		log.Fatalf("wmind desktop: %v", err)
	}
}

func run() error {
	// 单实例：第二次启动不再开窗口，由第一个实例处理（后续接入深链接与
	// 文件关联时，这里也是接收参数的地方）。
	if !mygo.App.RequestSingleInstanceLock() {
		return nil
	}

	mygo.App.WhenReady(func() {
		if err := start(); err != nil {
			log.Printf("wmind desktop: %v", err)
			mygo.App.Quit()
		}
	})
	return mygo.App.Run()
}

func start() error {
	userData, err := mygo.App.Path(mygo.PathUserData)
	if err != nil {
		return fmt.Errorf("resolve user data directory: %w", err)
	}
	if err := os.MkdirAll(userData, 0o700); err != nil {
		return fmt.Errorf("create user data directory: %w", err)
	}

	token, err := newToken()
	if err != nil {
		return err
	}

	handler, err := localserver.New(localserver.Config{
		// 后端 router 在下一步接入；现在只验证壳、回环服务与令牌守卫。
		API:     http.NotFoundHandler(),
		Token:   token,
		Mode:    "local",
		Version: appVersion(),
	})
	if err != nil {
		return err
	}

	ln, err := localserver.Listen()
	if err != nil {
		return fmt.Errorf("listen on loopback: %w", err)
	}
	srv := &http.Server{Handler: handler, ReadHeaderTimeout: 10 * time.Second}
	go func() {
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Printf("wmind desktop: local server stopped: %v", err)
		}
	}()
	mygo.App.OnWillQuit(func(*mygo.QuitEvent) {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx)
	})

	url := "http://" + ln.Addr().String() + "/"
	log.Printf("wmind desktop: local server listening on %s", url)

	mygo.NewWindow(mygo.WindowOptions{
		Title:  "wmind",
		URL:    url,
		Width:  1280,
		Height: 800,
	})
	return nil
}

// appVersion 返回注入的版本，未注入时退回 mygo 配置里的版本。
func appVersion() string {
	if version != "" {
		return version
	}
	return mygo.App.Version()
}

// newToken 生成桌面壳的访问令牌：32 字节随机，仅存在于本次进程与页面 cookie。
func newToken() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("generate token: %w", err)
	}
	return hex.EncodeToString(buf), nil
}
