//go:build !desktopfrontend

// 默认构建（不带 desktopfrontend 标签）嵌的是占位页。
//
// 这样 `go build ./...` 在没构建过前端的机器上也能通过，而正式产物由
// scripts/build-desktop.mjs 用 -tags desktopfrontend 嵌入（见 frontend_embed.go）。
package main

import (
	"embed"
	"io/fs"
)

//go:embed all:frontend-placeholder
var frontendFiles embed.FS

// frontendDist 返回前端产物的只读文件系统。
func frontendDist() fs.FS {
	sub, err := fs.Sub(frontendFiles, "frontend-placeholder")
	if err != nil {
		return nil
	}
	return sub
}
