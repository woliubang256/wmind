// 打开本地文件：把「系统让应用打开的文件」交给前端。
//
// 桌面壳（main.go）只负责把文件收进 openfiles.Queue 并敲一下页面；真正的打开
// 流程（解析、建图、跳转、询问「仅查看 / 转换」）全在前端，因为那里才有编辑器
// 与导入适配器。这组接口就是两端之间的全部契约：
//
//	GET  /desktop/open-files              待打开列表（页面挂载时兜底拉取）
//	GET  /desktop/open-files/{id}/bytes   文件字节
//	POST /desktop/open-files/{id}/done    处理完毕（可带上建好的导图，记下来源）
//	POST /desktop/open-files/{id}/reveal  在文件管理器中显示
//	GET  /desktop/maps/by-source?path=    按来源路径反查已转换的导图
//	POST /desktop/maps/{uid}/reveal-source 在文件管理器中显示这份导图的来源文件
package deskapi

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/woliubang256/wmind/backend/desktop/internal/mapsource"
	"github.com/woliubang256/wmind/backend/desktop/internal/openfiles"
)

func (a *api) openFiles(w http.ResponseWriter, r *http.Request) {
	items := a.deps.OpenFiles.List()
	if items == nil {
		items = []openfiles.File{}
	}
	writeJSON(w, http.StatusOK, envelope{Data: items})
}

func (a *api) openFileBytes(w http.ResponseWriter, r *http.Request) {
	body, file, err := a.deps.OpenFiles.Read(r.PathValue("id"))
	switch {
	case errors.Is(err, openfiles.ErrNotFound):
		fail(w, http.StatusNotFound, "这个文件已经处理过了，请重新打开")
		return
	case errors.Is(err, openfiles.ErrTooLarge):
		fail(w, http.StatusRequestEntityTooLarge, "文件超过 50 MB 上限")
		return
	case err != nil:
		if file.Missing || errors.Is(err, os.ErrNotExist) {
			fail(w, http.StatusNotFound, "来源文件已不在原位置")
			return
		}
		fail(w, http.StatusInternalServerError, errorText(err))
		return
	}
	// 扩展名决定类型：`.xmind` 是 zip，`.wmind` 是 JSON 文档。其余（不应该
	// 出现，队列已经挡过）按二进制给，让调用方自己探测。
	contentType := "application/octet-stream"
	if file.Ext == "wmind" {
		contentType = "application/json"
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
}

// doneOpenFile 结束一次「打开文件」。带上 mapUid 时同时记下来源路径：
//
//   - 之后双击同一个文件会直接打开这张导图（去重）；
//   - 列表卡片上的「打开文件所在目录」靠它找到文件。
func (a *api) doneOpenFile(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var body struct {
		MapUID string `json:"mapUid"`
	}
	if r.Body != nil && r.ContentLength != 0 {
		r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
		decoder := json.NewDecoder(r.Body)
		if err := decoder.Decode(&body); err != nil {
			fail(w, http.StatusBadRequest, "请求格式不正确")
			return
		}
		var extra any
		if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
			fail(w, http.StatusBadRequest, "请求格式不正确")
			return
		}
	}
	file, ok := a.deps.OpenFiles.Take(id)
	if !ok {
		fail(w, http.StatusNotFound, "这个文件已经处理过了，请重新打开")
		return
	}
	if body.MapUID != "" && a.deps.Sources != nil {
		size := file.Size
		var modTime *time.Time
		if info, err := os.Stat(file.Path); err == nil && !info.IsDir() {
			size = info.Size()
			at := info.ModTime().UTC()
			modTime = &at
		}
		record := &mapsource.Record{MapUID: body.MapUID, Path: file.Path, Name: file.Name, Size: size, ModTime: modTime}
		if err := a.deps.Sources.Put(r.Context(), record); err != nil {
			// 来源记录只是去重与「显示在文件夹中」的附加信息：写不进去不该
			// 让「文件已经打开」这件事失败。
			if a.deps.Logger != nil {
				a.deps.Logger.Warn("open-file: save source failed", "err", err)
			}
		}
	}
	writeJSON(w, http.StatusOK, envelope{Data: map[string]bool{"done": true}})
}

func (a *api) revealOpenFile(w http.ResponseWriter, r *http.Request) {
	file, ok := a.deps.OpenFiles.Get(r.PathValue("id"))
	if !ok {
		fail(w, http.StatusNotFound, "这个文件已经处理过了，请重新打开")
		return
	}
	if file.Missing {
		fail(w, http.StatusNotFound, "来源文件已不在原位置")
		return
	}
	if info, err := os.Stat(file.Path); err != nil || info.IsDir() {
		fail(w, http.StatusNotFound, "来源文件已不在原位置")
		return
	}
	a.reveal(w, file.Path)
}

// mapBySource 按来源路径反查导图。没有记录时 404——调用方据此决定「新建一张」。
func (a *api) mapBySource(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Query().Get("path")
	if path == "" {
		fail(w, http.StatusBadRequest, "缺少文件路径")
		return
	}
	if a.deps.Sources == nil {
		fail(w, http.StatusNotFound, "没有来源记录")
		return
	}
	record, err := a.deps.Sources.ByPath(r.Context(), path)
	if errors.Is(err, mapsource.ErrNotFound) {
		fail(w, http.StatusNotFound, "没有来源记录")
		return
	}
	if err != nil {
		fail(w, http.StatusInternalServerError, errorText(err))
		return
	}
	writeJSON(w, http.StatusOK, envelope{Data: mapSourceItem{
		MapUID: record.MapUID, Path: record.Path, Name: record.Name,
		Size: record.Size, Exists: mapsource.Exists(record),
	}})
}

func (a *api) revealMapSource(w http.ResponseWriter, r *http.Request) {
	mapUID := r.PathValue("uid")
	if mapUID == "" {
		fail(w, http.StatusBadRequest, "缺少导图标识")
		return
	}
	if a.deps.Sources == nil {
		fail(w, http.StatusNotFound, "这份导图不是从本地文件打开的")
		return
	}
	record, err := a.deps.Sources.Get(r.Context(), mapUID)
	if errors.Is(err, mapsource.ErrNotFound) {
		fail(w, http.StatusNotFound, "这份导图不是从本地文件打开的")
		return
	}
	if err != nil {
		fail(w, http.StatusInternalServerError, errorText(err))
		return
	}
	if !mapsource.Exists(record) {
		fail(w, http.StatusNotFound, "来源文件已不在原位置")
		return
	}
	a.reveal(w, record.Path)
}

// mapSourceItem 是「这份导图的来源文件」。
type mapSourceItem struct {
	MapUID string `json:"mapUid"`
	Path   string `json:"path"`
	Name   string `json:"name"`
	Size   int64  `json:"size"`
	// Exists 表示文件现在还在原位置。不在时界面不显示「打开所在目录」，
	// 否则点了只会弹一个系统的「文件不存在」。
	Exists bool `json:"exists"`
}

// reveal 在文件管理器中显示文件（访达 / 资源管理器 / 文件管理器）。
//
// 失败原因通常是系统没有可用的文件管理器（极简 Linux 环境）：此时退回「打开
// 所在目录」，仍失败才报错。两件都是尽力而为，不重试。
func (a *api) reveal(w http.ResponseWriter, path string) {
	if a.deps.RevealInFolder == nil {
		fail(w, http.StatusNotImplemented, "当前构建不支持在文件管理器中显示")
		return
	}
	if err := a.deps.RevealInFolder(path); err != nil {
		if _, openErr := os.Stat(filepath.Dir(path)); openErr != nil {
			fail(w, http.StatusNotFound, "来源文件已不在原位置")
			return
		}
		fail(w, http.StatusInternalServerError, errorText(err))
		return
	}
	writeJSON(w, http.StatusOK, envelope{Data: map[string]bool{"revealed": true}})
}
