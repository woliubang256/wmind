//go:build !linux && !darwin && !freebsd && !openbsd && !netbsd && !dragonfly && !windows

package backup

// sharedFileLock 在没有文件锁实现的平台上退化为「不做跨进程协调」。
//
// 这里**不能返回错误**：备份服务的维护锁只是「多进程共享同一上传卷时互相
// 让路」的优化，单进程部署（桌面端、单实例服务）根本不需要它。早期版本在这
// 里返回错误，结果是 Windows 桌面上应用直接起不来。
func sharedFileLock(path string, exclusive bool) (func(), bool, error) {
	_ = path
	_ = exclusive
	return func() {}, true, nil
}
