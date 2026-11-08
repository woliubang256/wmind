//go:build desktopfrontend

// 正式构建：嵌入 scripts/build-desktop.mjs 写入的 frontend-dist（不进版本库）。
package main

import (
	"embed"
	"io/fs"
)

//go:embed all:frontend-dist
var frontendFiles embed.FS

// frontendDist 返回前端产物的只读文件系统。
func frontendDist() fs.FS {
	sub, err := fs.Sub(frontendFiles, "frontend-dist")
	if err != nil {
		return nil
	}
	return sub
}
