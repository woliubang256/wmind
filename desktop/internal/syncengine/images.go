package syncengine

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/woliubang256/wmind/backend/desktop/internal/cloud"
	"github.com/woliubang256/wmind/backend/desktop/internal/syncstate"
	"github.com/woliubang256/wmind/backend/internal/backup"
	"github.com/woliubang256/wmind/backend/internal/pkg/apperr"
	"github.com/woliubang256/wmind/backend/internal/service"
)

// LocalImages is the desktop's attachment store and its maintenance gate.
type LocalImages struct {
	Files *service.FileService
	Dir   string
	Gate  *backup.Gate
}

func (e *Engine) readLocalImage(path string) ([]byte, error) {
	key, valid := cloud.ImageKey(path)
	if !valid {
		return nil, errors.New("无效的本机图片地址")
	}
	root, err := os.OpenRoot(e.images.Dir)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	info, err := root.Lstat(key)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, errors.New("本机图片不是普通文件")
	}
	file, err := root.Open(key)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	maxBytes := e.images.Files.MaxBytes()
	data, err := io.ReadAll(io.LimitReader(file, maxBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) == 0 || int64(len(data)) > maxBytes {
		return nil, errors.New("本机图片超出上传大小限制或为空")
	}
	return data, nil
}

func (e *Engine) enterLocalWrite() (func(), error) {
	if e.images == nil {
		return func() {}, nil
	}
	leave, ok := e.images.Gate.Enter()
	if !ok {
		return nil, errors.New("正在执行本机备份或恢复，请稍后同步")
	}
	return leave, nil
}

// transferImages rewrites a copy of the document for its destination. Mappings
// are stored as each image succeeds, independently of the eventual map write.
func (e *Engine) transferImages(ctx context.Context, remote Remote, document []byte, toCloud bool) ([]byte, error) {
	client, ok := remote.(*cloud.Client)
	if !ok || e.images == nil {
		return document, nil
	}

	var scope string
	translated := make(map[string]string)
	return service.TransformDocumentImages(document, func(src string) (string, error) {
		if !strings.HasPrefix(src, "/uploads/") {
			return src, nil
		}
		if _, valid := cloud.ImageKey(src); !valid {
			return "", errors.New("无效的主题图片地址")
		}
		if dst, ok := translated[src]; ok {
			return dst, nil
		}
		if scope == "" {
			session := client.Session()
			if session.UserUID == "" {
				if err := client.RefreshAfter(ctx, ""); err != nil {
					return "", err
				}
				session = client.Session()
			}
			if session.UserUID == "" {
				return "", errors.New("无法确认云端图片所属账号")
			}
			scope = hashBytes([]byte(session.ServerURL + "\x00" + session.UserUID))
		}
		var dst string
		var err error
		if toCloud {
			dst, err = e.uploadImage(ctx, client, scope, src)
		} else {
			dst, err = e.downloadImage(ctx, client, scope, src)
		}
		if err != nil {
			return "", fmt.Errorf("同步主题图片 %s 失败: %w", src, err)
		}
		translated[src] = dst
		return dst, nil
	})
}

func (e *Engine) uploadImage(ctx context.Context, client *cloud.Client, scope, src string) (string, error) {
	if err := e.images.Files.ValidateURL(ctx, e.ownerID, src); err != nil {
		return "", err
	}
	dst, err := e.store.GetMeta(ctx, syncstate.ImageMappingKey(scope, "local", src))
	if err != nil {
		return "", err
	}
	if dst != "" {
		exists, err := client.HasImage(ctx, dst)
		if err != nil || exists {
			return dst, err
		}
	}
	data, err := e.readLocalImage(src)
	if err != nil {
		return "", err
	}
	dst, err = client.UploadImage(ctx, data)
	if err != nil {
		return "", err
	}
	return dst, e.store.PutImageMapping(ctx, scope, src, dst)
}

func (e *Engine) downloadImage(ctx context.Context, client *cloud.Client, scope, src string) (string, error) {
	dst, err := e.store.GetMeta(ctx, syncstate.ImageMappingKey(scope, "remote", src))
	if err != nil {
		return "", err
	}
	if _, valid := cloud.ImageKey(dst); valid {
		err := e.images.Files.ValidateURL(ctx, e.ownerID, dst)
		if err == nil {
			return dst, nil
		}
		if !apperr.Is(err, apperr.CodeValidationFailed) {
			return "", err
		}
	}
	data, err := client.DownloadImage(ctx, src)
	if err != nil {
		return "", err
	}
	local, err := e.images.Files.Upload(ctx, e.ownerID, data)
	if err != nil {
		return "", err
	}
	return local.URL, e.store.PutImageMapping(ctx, scope, local.URL, src)
}
