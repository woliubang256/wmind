// Package openfiles 管理「用户让应用打开的文件」：双击已关联的类型、在访达 /
// 资源管理器里「打开方式 → Wmind」、把文件拖到 Dock / 任务栏图标上，以及第二个
// 实例把这些参数转交给第一个实例。
//
// 为什么需要一个队列而不是直接开窗口：
//
//   - 事件可能**早于页面就绪**到达（冷启动时文件参数在首屏之前就有了），此时在
//     页面里派发事件会静默丢失；
//   - 一次可能带多个文件，而前端的「打开」流程是异步的（读字节、解析、建图、
//     跳转），不能并行跑；
//   - 前端崩溃重载后要能重新取到还没处理完的文件。
//
// 所以桌面壳只做一件事：把系统给的文件收进队列，并「敲一下」页面。前端拿到待
// 打开列表后自己决定怎么处理（见 web/src/features/open-file/）。
//
// 队列只保存**路径与文件元信息**，不缓存内容：文件可能被用户改过，读字节必须
// 发生在真正要打开的那一刻（见 Read）。
package openfiles

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"
)

// MaxBytes 是单个文件允许读取的上限。
//
// 与前端导入上限（`IMPORT_LIMITS.maxInputBytes`，50 MiB）保持一致：同一个文件
// 通过「双击打开」与通过「导入对话框」进来，不该有两种结论。这里再挡一次是因为
// 读取发生在 Go 侧，不能指望调用方先查过大小。
const MaxBytes = 50 << 20

// MaxPending 是队列里同时待处理的文件数上限。
//
// 多选几百个文件再「打开方式 → Wmind」是可能的，但那是误操作而不是需求；超出
// 部分直接丢弃，避免把内存与后续导入流程一起拖垮。
const MaxPending = 100

// Extensions 是应用声明关联、因而会从系统收到的扩展名（小写、不含点）。
//
// 必须与 desktop/mygo.json 的 fileAssociations 一致：这里是「接受什么」，那里是
// 「向系统声明什么」。多一个会让系统送来前端处理不了的文件，少一个则那类文件
// 根本走不到这里。
var Extensions = []string{"wmind", "xmind"}

// ErrNotFound 表示队列里没有这个 id（可能已被处理，或进程重启过）。
var ErrNotFound = errors.New("待打开的文件不存在")

// ErrTooLarge 表示文件超过 MaxBytes。
var ErrTooLarge = errors.New("文件超过大小上限")

// File 是一个待打开的文件。
type File struct {
	// ID 只在本次进程内有效，用来读取字节与确认处理完毕。
	ID string `json:"id"`
	// Path 是绝对路径。
	Path string `json:"path"`
	// Name 是文件名（含扩展名），界面上的标题。
	Name string `json:"name"`
	// Ext 是小写扩展名，不含点。前端据此决定「直接打开」还是「弹窗询问」。
	Ext string `json:"ext"`
	// Size 是字节数；文件已不存在时为 0。
	Size int64 `json:"size"`
	// ModTime 是文件的修改时间（RFC3339），前端可据此提示「文件已更新」。
	ModTime string `json:"modTime,omitempty"`
	// Missing 表示收到路径时文件已经不在了（被删、被移走、权限不足）。仍然
	// 入队是为了让界面能明确告诉用户「找不到这个文件」，而不是「没反应」。
	Missing bool `json:"missing"`
}

// Queue 是待打开文件队列。并发安全（监听器在锁外调用）。
type Queue struct {
	mu    sync.Mutex
	next  int
	items []File
	// listeners 在文件入队后、**释放锁之后**按注册顺序调用：监听方要跑 JS，
	// 不能持锁。
	listeners []func(File)
}

// New 构造空队列。
func New() *Queue { return &Queue{} }

// OnAdd 注册「有文件入队」的监听器。
//
// 只用于「敲一下页面」，不承担可靠性：监听器可能因为页面尚未就绪而失败，
// 前端挂载时还会主动拉一次 List。
func (q *Queue) OnAdd(fn func(File)) {
	if fn == nil {
		return
	}
	q.mu.Lock()
	q.listeners = append(q.listeners, fn)
	q.mu.Unlock()
}

// Add 把系统给的文件加入队列，返回真正被接受的那些。
//
// 同一个路径再次打开时**替换**旧条目而不是新增：用户重复双击同一个文件，期望的
// 是「再打开一次」，不是「排两个一模一样的任务」。
func (q *Queue) Add(paths []string) []File {
	if len(paths) == 0 {
		return nil
	}

	q.mu.Lock()
	accepted := make([]File, 0, len(paths))
	seen := make(map[string]struct{}, len(paths))
	for _, path := range paths {
		file, ok := describe(path)
		if !ok {
			continue
		}
		if _, duplicate := seen[file.Path]; duplicate {
			continue
		}
		seen[file.Path] = struct{}{}
		file.ID = fmt.Sprintf("open-%d", q.next)
		q.next++

		if index := slices.IndexFunc(q.items, func(item File) bool { return item.Path == file.Path }); index >= 0 {
			q.items[index] = file
			accepted = append(accepted, file)
			continue
		}
		if len(q.items) >= MaxPending {
			continue
		}
		q.items = append(q.items, file)
		accepted = append(accepted, file)
	}
	listeners := slices.Clone(q.listeners)
	q.mu.Unlock()

	for _, file := range accepted {
		for _, fn := range listeners {
			// A listener is a notification aid, not the queue's correctness boundary.
			// One faulty listener must not prevent the remaining listeners from seeing
			// the file or make the system event callback panic.
			func() {
				defer func() { _ = recover() }()
				fn(file)
			}()
		}
	}
	return accepted
}

// List 返回待打开的文件，按入队顺序（最早的在前）。
func (q *Queue) List() []File {
	q.mu.Lock()
	defer q.mu.Unlock()
	return slices.Clone(q.items)
}

// Get 取一个待打开文件。
func (q *Queue) Get(id string) (File, bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	for _, file := range q.items {
		if file.ID == id {
			return file, true
		}
	}
	return File{}, false
}

// Read 读取文件内容。超过 MaxBytes 时返回 ErrTooLarge；id 不存在时返回
// ErrNotFound，调用方据此给出「请重新打开」而不是「读取失败」。
func (q *Queue) Read(id string) ([]byte, File, error) {
	file, ok := q.Get(id)
	if !ok {
		return nil, File{}, ErrNotFound
	}
	handle, err := os.Open(file.Path)
	if err != nil {
		return nil, file, fmt.Errorf("打开文件失败：%w", err)
	}
	defer func() { _ = handle.Close() }()

	// 多读一个字节：即使 stat 与真实长度不一致（文件正在被追加），也能发现超限。
	body, err := io.ReadAll(io.LimitReader(handle, MaxBytes+1))
	if err != nil {
		return nil, file, fmt.Errorf("读取文件失败：%w", err)
	}
	if len(body) > MaxBytes {
		return nil, file, ErrTooLarge
	}
	return body, file, nil
}

// Take atomically removes and returns a queued file. It is used by the completion
// endpoint so two concurrent retries cannot both claim the same launch.
func (q *Queue) Take(id string) (File, bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	for index, file := range q.items {
		if file.ID != id {
			continue
		}
		q.items = slices.Delete(q.items, index, index+1)
		return file, true
	}
	return File{}, false
}

// Remove 把已处理完（或用户放弃）的文件移出队列。重复调用无副作用。
func (q *Queue) Remove(id string) {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.items = slices.DeleteFunc(q.items, func(file File) bool { return file.ID == id })
}

// describe 校验并描述一个路径；扩展名不关联或指向目录时返回 false。
func describe(path string) (File, bool) {
	cleaned := filepath.Clean(strings.TrimSpace(path))
	if cleaned == "" || cleaned == "." {
		return File{}, false
	}
	absolute, err := filepath.Abs(cleaned)
	if err != nil {
		return File{}, false
	}
	ext := strings.ToLower(strings.TrimPrefix(filepath.Ext(absolute), "."))
	if !slices.Contains(Extensions, ext) {
		return File{}, false
	}

	file := File{Path: absolute, Name: filepath.Base(absolute), Ext: ext}
	info, err := os.Stat(absolute)
	switch {
	case err != nil:
		// 路径在事件与处理之间消失（被删、被移走、挂载被卸载）：照样入队，
		// 让界面明确说「找不到」，而不是静默什么都不做。
		file.Missing = true
		return file, true
	case info.IsDir():
		return File{}, false
	}
	file.Size = info.Size()
	file.ModTime = info.ModTime().UTC().Format(time.RFC3339Nano)
	return file, true
}
