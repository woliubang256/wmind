//go:build !windows

package main

// webviewRuntimeHint 在非 Windows 平台不做检查：macOS 与 Linux 的 WebView 由系统
// 或发行版提供，缺了会有明确报错（而不是静默退出）。
func webviewRuntimeHint() string { return "" }
