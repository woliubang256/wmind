// Command mcp 是 MCP 的 stdio 可执行文件。
//
// 单独编成一个小二进制，是为了让客户端的配置写成一条**不带空格、不带参数**的
// 路径：
//
//	macOS   /Applications/Wmind.app/Contents/Resources/wmind_mcp
//	Windows %LOCALAPPDATA%\Programs\Wmind\wmind_mcp.exe
//	Linux   ~/.local/bin/wmind_mcp
//
// 它和主程序共用同一份本地数据（SQLite），所以主程序没开着也能用。
package main

import (
	"os"

	"github.com/woliubang256/wmind/backend/desktop/internal/mcpmode"
)

// version 由构建时注入，与主程序一致。
var version = ""

func main() {
	os.Exit(mcpmode.Run(version))
}
