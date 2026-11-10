//go:build windows

package main

import (
	"fmt"
	"os"
	"path/filepath"

	"golang.org/x/sys/windows/registry"
)

// webviewRuntimeHint 检查 Windows 上是否装了 WebView2 运行时。
//
// 没有它时 mygo 建不出窗口，进程会在「应用就绪」之前就退出——用户看到的就是
// 「双击没反应、没有窗口、也没有报错」。这里提前查一次，好在日志和弹窗里说清楚
// 该装什么，而不是让人猜。
//
// 返回空字符串表示看起来装了；否则返回给用户看的说明。
func webviewRuntimeHint() string {
	// 1) Edge WebView2 的 Evergreen 运行时把版本写在 EdgeUpdate 的客户端键下。
	const clientGUID = `{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}`
	for _, root := range []registry.Key{registry.LOCAL_MACHINE, registry.CURRENT_USER} {
		for _, path := range []string{
			`SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\` + clientGUID,
			`SOFTWARE\Microsoft\EdgeUpdate\Clients\` + clientGUID,
		} {
			key, err := registry.OpenKey(root, path, registry.QUERY_VALUE)
			if err != nil {
				continue
			}
			version, _, err := key.GetStringValue("pv")
			_ = key.Close()
			if err == nil && version != "" && version != "0.0.0.0" {
				return ""
			}
		}
	}
	// 2) 兜底看安装目录：某些企业部署只落文件不写注册表。
	for _, env := range []string{"ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA"} {
		base := os.Getenv(env)
		if base == "" {
			continue
		}
		if info, err := os.Stat(filepath.Join(base, "Microsoft", "EdgeWebView", "Application")); err == nil && info.IsDir() {
			return ""
		}
	}
	return fmt.Sprintf("未检测到 WebView2 运行时。请安装微软的 WebView2 Evergreen Runtime 后重试：%s",
		"https://developer.microsoft.com/microsoft-edge/webview2/")
}
