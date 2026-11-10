//go:build windows

package backup

import (
	"errors"
	"os"

	"golang.org/x/sys/windows"
)

// sharedFileLock 在 Windows 上用 LockFileEx 实现共享/独占锁。
//
// 语义与 unix 的 flock 对齐：拿不到锁时返回 (nil, false, nil)，由调用方当作
// 「另一个进程正在维护」处理，而不是报错——报错会让整个应用起不来
// （Windows 桌面端 1.1.1 之前就是这样：备份服务的维护锁初始化失败，直接
// 阻断启动）。
//
// 共享锁 = 不带 LOCKFILE_EXCLUSIVE_LOCK；加 LOCKFILE_FAIL_IMMEDIATELY 让
// 拿不到锁时立刻返回，而不是阻塞启动。
func sharedFileLock(path string, exclusive bool) (func(), bool, error) {
	if path == "" {
		return func() {}, true, nil
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, false, err
	}
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		_ = f.Close()
		if err == nil {
			err = errors.New("maintenance lock must be a regular file")
		}
		return nil, false, err
	}
	flags := uint32(windows.LOCKFILE_FAIL_IMMEDIATELY)
	if exclusive {
		flags |= windows.LOCKFILE_EXCLUSIVE_LOCK
	}
	handle := windows.Handle(f.Fd())
	overlapped := new(windows.Overlapped)
	if err := windows.LockFileEx(handle, flags, 0, 1, 0, overlapped); err != nil {
		_ = f.Close()
		if errors.Is(err, windows.ERROR_LOCK_VIOLATION) || errors.Is(err, windows.ERROR_IO_PENDING) {
			return nil, false, nil
		}
		return nil, false, err
	}
	return func() {
		_ = windows.UnlockFileEx(handle, 0, 1, 0, overlapped)
		_ = f.Close()
	}, true, nil
}
