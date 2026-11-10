// Package logging 提供桌面端的日志：按大小滚动的文件 + 可选的标准错误输出。
//
// 桌面应用没有控制台，用户能提供的唯一线索就是这个文件，所以两件事必须做到：
//
//  1. **滚动**：长时间使用（自动保存、同步、HTTP 请求都记）会把单文件撑到几十
//     MB，用户想发给我们时既传不动也不好打开。超过上限就换文件、只留最近几份。
//  2. **一定写得出来**：目录创建失败、文件被占用（Windows 上杀软扫描时会出现）
//     都不能让应用起不来——退化成只写 stderr，启动流程照常。
package logging

import (
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
)

const (
	// defaultMaxBytes 是单个日志文件的上限：5 MiB 足够装下几天的正常使用。
	defaultMaxBytes = 5 << 20
	// defaultBackups 是保留的历史文件数量（wmind.log.1 … wmind.log.5）。
	defaultBackups = 5
)

// RotatingWriter 是带滚动的日志写入器：写满就改名，最旧的被丢弃。
type RotatingWriter struct {
	path       string
	maxBytes   int64
	maxBackups int

	mu   sync.Mutex
	file *os.File
	size int64
}

// NewRotatingWriter 打开（或创建）path 处的日志文件。
func NewRotatingWriter(path string, maxBytes int64, maxBackups int) (*RotatingWriter, error) {
	if maxBytes <= 0 {
		maxBytes = defaultMaxBytes
	}
	if maxBackups <= 0 {
		maxBackups = defaultBackups
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	w := &RotatingWriter{path: path, maxBytes: maxBytes, maxBackups: maxBackups}
	if err := w.open(); err != nil {
		return nil, err
	}
	return w, nil
}

func (w *RotatingWriter) open() error {
	file, err := os.OpenFile(w.path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	info, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return err
	}
	w.file = file
	w.size = info.Size()
	return nil
}

// Write 写入一条日志；超过上限时先滚动再写。
func (w *RotatingWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.file == nil {
		if err := w.open(); err != nil {
			return 0, err
		}
	}
	if w.size+int64(len(p)) > w.maxBytes {
		if err := w.rotate(); err != nil {
			// 滚动失败不该丢日志：继续往当前文件写。
			_ = err
		}
	}
	n, err := w.file.Write(p)
	w.size += int64(n)
	return n, err
}

// rotate 把当前文件改名为 .1，其余依次后移，超出保留数的删除。
func (w *RotatingWriter) rotate() error {
	if w.file != nil {
		_ = w.file.Close()
		w.file = nil
	}
	// wmind.log.(n) → wmind.log.(n+1)，从最旧的开始，避免覆盖。
	for i := w.maxBackups - 1; i >= 1; i-- {
		from := fmt.Sprintf("%s.%d", w.path, i)
		to := fmt.Sprintf("%s.%d", w.path, i+1)
		_ = os.Rename(from, to)
	}
	_ = os.Rename(w.path, w.path+".1")
	return w.open()
}

// Close 关闭文件。
func (w *RotatingWriter) Close() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.file == nil {
		return nil
	}
	err := w.file.Close()
	w.file = nil
	return err
}

// Options 是日志的构造参数。
type Options struct {
	// Root 是应用数据目录，日志写到 <Root>/logs/wmind.log。
	Root string
	// Level 覆盖日志级别（WMIND_DESKTOP_LOG_LEVEL），为空时用 INFO。
	Level string
	// Stderr 为真时同时写标准错误（`go run` 与开发时看得见）。
	Stderr bool
}

// New 构造桌面端日志。
//
// 返回的 close 必须调用（正常退出时刷盘并关文件）。
func New(opts Options) (*slog.Logger, func(), error) {
	level := levelFrom(opts.Level)
	path := filepath.Join(opts.Root, "logs", "wmind.log")

	writer, err := NewRotatingWriter(path, SizeEnv(), defaultBackups)
	if err != nil {
		// 写不了文件也不能让应用起不来：退化成只写 stderr。
		logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: level}))
		return logger, func() {}, fmt.Errorf("open log file: %w", err)
	}
	var out io.Writer = writer
	if opts.Stderr {
		out = io.MultiWriter(os.Stderr, writer)
	}
	logger := slog.New(slog.NewTextHandler(out, &slog.HandlerOptions{Level: level}))
	return logger, func() { _ = writer.Close() }, nil
}

// levelFrom 解析级别名；无法识别时用 INFO（宁多记也不少记）。
func levelFrom(name string) slog.Level {
	switch strings.ToLower(strings.TrimSpace(name)) {
	case "debug":
		return slog.LevelDebug
	case "warn", "warning":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}

// SizeEnv 是覆盖单个日志文件上限的环境变量（字节），便于排查时临时调大。
func SizeEnv() int64 {
	if raw := os.Getenv("WMIND_DESKTOP_LOG_MAX_BYTES"); raw != "" {
		if value, err := strconv.ParseInt(raw, 10, 64); err == nil && value > 0 {
			return value
		}
	}
	return defaultMaxBytes
}
