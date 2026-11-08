module github.com/woliubang256/wmind/backend/desktop

// mygo 要求 Go 1.27.3；后端服务仍是 1.26.10（安全基线）。模块路径落在
// backend 之下，因此这里可以直接复用 backend/internal/*，而 Web 侧工具链
// 不受影响。详见 .agents/notes/proposed/architecture/2026-11-08-wmind-desktop-client.md
go 1.27.3

require github.com/egoist/mygo v0.8.3

require (
	github.com/ebitengine/purego v0.11.1 // indirect
	golang.org/x/image v0.47.0 // indirect
	golang.org/x/net v0.61.0 // indirect
	golang.org/x/text v0.43.0 // indirect
)

replace github.com/woliubang256/wmind/backend => ../
