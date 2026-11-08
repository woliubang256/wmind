package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/egoist/mygo"

	"github.com/woliubang256/wmind/backend/desktop/internal/deskapi"
)

// updaterAdapter 把 mygo 的更新器包成 deskapi 需要的那几个动作。
//
// 为什么不让 deskapi 直接 import mygo：接口在 deskapi 里定义，测试就能塞一个
// 假实现；否则「检查更新」这件事只能靠真发一次 GitHub 请求来验证。
type updaterAdapter struct {
	mu sync.Mutex
	// pending 是 Check 找到的新版本（未安装）。
	pending *mygo.Update
	// phase 是安装进度状态机：idle → downloading → ready →（重启后）idle。
	phase      string
	downloaded int64
	total      int64
	err        string
	installing bool
}

func newUpdaterAdapter() *updaterAdapter {
	// 自托管更新源（也用于本地验证整条升级链）：把 mygo 的更新源换成一个
	// 普通 HTTP 目录，里面放 mygo build 产出的 update-<os>-<arch>.json 与归档。
	// 不设置时走 mygo.json 里配置的 GitHub release。
	if feed := strings.TrimSpace(os.Getenv("WMIND_UPDATE_FEED")); feed != "" {
		mygo.Updater.SetSource(httpFeed{base: strings.TrimRight(feed, "/")})
	}
	return &updaterAdapter{phase: "idle"}
}

// httpFeed 从 http(s) 目录读更新清单与文件。
type httpFeed struct{ base string }

func (f httpFeed) Manifest(ctx context.Context, _ bool) (io.ReadCloser, error) {
	return f.Open(ctx, f.base+"/update-"+runtime.GOOS+"-"+runtime.GOARCH+".json")
}

func (f httpFeed) Open(ctx context.Context, url string) (io.ReadCloser, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		return nil, fmt.Errorf("update feed returned HTTP %d", resp.StatusCode)
	}
	return resp.Body, nil
}

// Enabled 报告这个构建能不能自我更新。
func (u *updaterAdapter) Enabled() bool { return mygo.Updater.Enabled() }

// Check 查询是否有新版本。
func (u *updaterAdapter) Check(ctx context.Context) (*deskapi.UpdateInfo, error) {
	update, err := mygo.Updater.Check(ctx)
	if err != nil {
		// 「还没有发布过带这个标签的版本」= 这是首个版本，不是错误：安装包
		// 第一次装上去时 GitHub 上当然没有比它更新的东西。把它当「已是最新」，
		// 否则用户一启动就看到一句英文报错。
		if errors.Is(err, mygo.ErrUpdatesDisabled) || strings.Contains(err.Error(), "no release is published") {
			if errors.Is(err, mygo.ErrUpdatesDisabled) {
				return nil, err
			}
			return nil, nil
		}
		return nil, err
	}
	if update == nil {
		u.mu.Lock()
		u.pending = nil
		u.mu.Unlock()
		return nil, nil
	}
	u.mu.Lock()
	u.pending = update
	u.mu.Unlock()
	return &deskapi.UpdateInfo{
		Version: update.Version,
		Notes:   update.Notes,
		Date:    update.Date.UTC().Format(time.RFC3339),
	}, nil
}

// Progress 返回当前进度。
func (u *updaterAdapter) Progress() deskapi.UpdateProgress {
	u.mu.Lock()
	defer u.mu.Unlock()
	return deskapi.UpdateProgress{Phase: u.phase, Downloaded: u.downloaded, Total: u.total, Error: u.err}
}

// StartInstall 在后台下载并替换应用，进度通过 Progress 轮询。
//
// 下载失败不写坏任何东西：mygo 的更新器先校验签名再替换，替换发生在应用退出
// 之后，所以这里失败只需要把错误报给界面，用户继续用当前版本。
func (u *updaterAdapter) StartInstall(ctx context.Context) error {
	u.mu.Lock()
	update := u.pending
	if update == nil {
		u.mu.Unlock()
		return errors.New("没有待安装的更新")
	}
	if u.installing {
		u.mu.Unlock()
		return nil // 已经在装了，重复点击当作无事发生
	}
	u.installing = true
	u.phase = "downloading"
	u.downloaded = 0
	u.total = 0
	u.err = ""
	u.mu.Unlock()

	go func() {
		// 不能用请求的 context：HTTP 响应一写完它就被取消，下载会立刻以
		// "context canceled" 失败（这条是端到端测试抓出来的）。安装要活到
		// 下载结束，所以自己起一个带超时的后台 context。
		installCtx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
		defer cancel()
		defer func() {
			u.mu.Lock()
			u.installing = false
			u.mu.Unlock()
		}()
		err := update.Install(installCtx, func(downloaded, total int64) {
			u.mu.Lock()
			u.downloaded = downloaded
			u.total = total
			u.mu.Unlock()
		})
		u.mu.Lock()
		defer u.mu.Unlock()
		if err != nil {
			u.phase = "error"
			u.err = err.Error()
			return
		}
		u.phase = "ready"
	}()
	return nil
}

// Relaunch 重启应用以完成更新。
func (u *updaterAdapter) Relaunch() {
	mygo.App.Relaunch()
}
