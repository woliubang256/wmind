package storage

import (
	"context"
	"errors"
	"io/fs"
	"path/filepath"
	"strings"
)

// Usage 统计已落盘的普通文件。符号链接与尚未 rename 的上传不计入。
func (s *LocalStore) Usage(ctx context.Context) (int64, error) {
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	// 配置的根目录可以是链接；只在入口解析一次，不跟随目录内的链接。
	root, err := filepath.EvalSymlinks(s.dir)
	if err != nil {
		return 0, err
	}
	var total int64
	err = filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if err != nil {
			// 文件可能在扫描时被业务删除；根目录不存在属于配置错误。
			if path != root && errors.Is(err, fs.ErrNotExist) {
				return nil
			}
			return err
		}
		if entry.IsDir() || strings.HasPrefix(entry.Name(), ".upload-") || !entry.Type().IsRegular() {
			return nil
		}
		info, err := entry.Info()
		if errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		if err != nil {
			return err
		}
		if info.Mode().IsRegular() {
			total += info.Size()
		}
		return nil
	})
	return total, err
}
