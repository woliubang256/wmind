// Package storage 抽象文件落盘。
//
// 一期只有本地目录实现（docs/07：部署形态是单机 + 一个数据卷）。接口留着
// 是为了二期接对象存储时不必改 service —— 那时只加一个 S3 实现。
package storage

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// ErrInvalidKey 表示存储键不合法（含路径分隔符、上跳等）。
var ErrInvalidKey = errors.New("非法的存储键")

// Store 是文件存储接口。
//
// Save 返回可直接放进响应里的公开 URL；Delete 对不存在的键返回 nil
// （删除是幂等的，重复删除不该报错）。
type Store interface {
	Save(ctx context.Context, key string, data []byte) (string, error)
	Delete(ctx context.Context, key string) error
	// URL 返回键对应的公开地址，不检查文件是否存在。
	URL(key string) string
}

// LocalStore 把文件写到本地目录，并通过 URLPrefix 暴露。
type LocalStore struct {
	dir       string
	urlPrefix string
}

// NewLocalStore 创建本地存储。dir 不存在时自动创建。
func NewLocalStore(dir, urlPrefix string) (*LocalStore, error) {
	if dir == "" {
		return nil, errors.New("本地存储目录不能为空")
	}
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return nil, fmt.Errorf("创建存储目录 %s: %w", dir, err)
	}
	if urlPrefix == "" {
		urlPrefix = "/uploads"
	}
	return &LocalStore{dir: dir, urlPrefix: strings.TrimRight(urlPrefix, "/")}, nil
}

// Save 写入文件。
//
// 先写临时文件再 rename：进程在写到一半时被杀，目录里不会留下半张图片
// （半张图片比没有图片更难排查）。
func (s *LocalStore) Save(_ context.Context, key string, data []byte) (string, error) {
	path, err := s.path(key)
	if err != nil {
		return "", err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".upload-*")
	if err != nil {
		return "", fmt.Errorf("创建临时文件: %w", err)
	}
	tmpName := tmp.Name()
	defer func() { _ = os.Remove(tmpName) }()

	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return "", fmt.Errorf("写入临时文件: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return "", fmt.Errorf("关闭临时文件: %w", err)
	}
	if err := os.Rename(tmpName, path); err != nil {
		return "", fmt.Errorf("提交文件 %s: %w", key, err)
	}
	return s.URL(key), nil
}

// Delete 删除文件；不存在时返回 nil。
func (s *LocalStore) Delete(_ context.Context, key string) error {
	path, err := s.path(key)
	if err != nil {
		return err
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("删除文件 %s: %w", key, err)
	}
	return nil
}

// URL 返回键对应的公开地址。
func (s *LocalStore) URL(key string) string {
	return s.urlPrefix + "/" + key
}

// Dir 返回存储根目录，供 HTTP 层做静态文件映射。
func (s *LocalStore) Dir() string { return s.dir }

// path 把存储键解析为绝对路径，并拒绝任何越界写法。
//
// 键由服务端生成（uid + 时间戳），理论上不会含分隔符；这道校验是防御
// 「将来某个调用方把用户输入当键传进来」的情况——目录穿越只需要一次疏忽。
func (s *LocalStore) path(key string) (string, error) {
	if key == "" || strings.ContainsAny(key, `/\`) || key == "." || key == ".." {
		return "", fmt.Errorf("%w: %q", ErrInvalidKey, key)
	}
	return filepath.Join(s.dir, key), nil
}

var _ Store = (*LocalStore)(nil)
