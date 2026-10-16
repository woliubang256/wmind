// Package logger 构建全局 slog 日志器。
package logger

import (
	"log/slog"
	"os"
)

// New 按运行环境构建日志器。
//
// 生产环境输出 JSON（便于日志采集），开发环境输出文本并附带源码位置。
// 两者都写 stdout——容器场景下由运行时收集，不写文件。
func New(level string, production bool) *slog.Logger {
	opts := &slog.HandlerOptions{Level: parseLevel(level)}

	var handler slog.Handler
	if production {
		handler = slog.NewJSONHandler(os.Stdout, opts)
	} else {
		opts.AddSource = true
		handler = slog.NewTextHandler(os.Stdout, opts)
	}
	return slog.New(handler)
}

func parseLevel(level string) slog.Level {
	switch level {
	case "debug":
		return slog.LevelDebug
	case "warn":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}
