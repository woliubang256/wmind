package service

import (
	"context"
	"errors"
	"fmt"

	"github.com/woliubang256/wmind/backend/internal/imageproc"
	"github.com/woliubang256/wmind/backend/internal/pkg/apperr"
	"github.com/woliubang256/wmind/backend/internal/pkg/id"
	"github.com/woliubang256/wmind/backend/internal/storage"
)

// 图片上传限制。
const (
	// DefaultMaxFileBytes 是单张图片的大小上限。
	//
	// 8MB 是「一张手机照片」的量级：XMind 里内嵌的截图、贴图基本都在 1MB
	// 以内，8MB 留足余量，又不会让一个人用几十张图把磁盘写满。
	DefaultMaxFileBytes = 8 << 20
	// maxFilePixels 是像素数上限（约 4000 万，相当于 6300×6300）。
	//
	// 按像素而不是字节卡：一张纯色 10000×10000 的 PNG 压缩后只有几十 KB，
	// 字节闸门放它过去，解码时却要几百 MB 内存。
	maxFilePixels = 40_000_000
)

// UploadedFile 是一次上传的结果。
//
// UID 与 URL 分开返回：URL 是给 `<img src>` 用的，UID 是给后续「删除/替换」
// 用的。现在两者都能从对方推出来，但等对象存储接进来（URL 变成 CDN 域名）
// 就不成立了，所以一开始就分开。
type UploadedFile struct {
	UID    string `json:"uid"`
	URL    string `json:"url"`
	Width  int    `json:"width"`
	Height int    `json:"height"`
	// Format 是解码得到的真实格式（png / jpeg / gif / webp）。
	Format string `json:"format"`
	Bytes  int64  `json:"bytes"`
}

// FileServiceConfig 是 FileService 的依赖。
type FileServiceConfig struct {
	Store     storage.Store
	MaxBytes  int64
	MaxPixels int
}

// FileService 处理通用图片上传（导入时的图片还原、后续的缩略图）。
//
// 与 UserService.UpdateAvatar 的区别：头像会被**裁剪重编码**成固定规格，
// 这里保持原图不变——导入的图片是导图内容的一部分，重新编码会掉画质，
// 而且一张带透明通道的 PNG 转成 JPEG 会变成黑底。
type FileService struct {
	store     storage.Store
	maxBytes  int64
	maxPixels int
}

// NewFileService 构造文件服务。
func NewFileService(cfg FileServiceConfig) (*FileService, error) {
	if cfg.Store == nil {
		return nil, errors.New("FileService 需要存储实现")
	}
	if cfg.MaxBytes <= 0 {
		cfg.MaxBytes = DefaultMaxFileBytes
	}
	if cfg.MaxPixels <= 0 {
		cfg.MaxPixels = maxFilePixels
	}
	return &FileService{store: cfg.Store, maxBytes: cfg.MaxBytes, maxPixels: cfg.MaxPixels}, nil
}

// MaxBytes 返回单文件上限，供 HTTP 层提前卡住请求体。
func (s *FileService) MaxBytes() int64 { return s.maxBytes }

// Upload 校验并保存一张图片，返回可公开访问的地址。
//
// 判定「是不是图片」靠解码而不是 Content-Type 或扩展名：后两者都由客户端
// 提供，可以随便写。落盘扩展名也取自解码结果，否则「.png 结尾的 HTML」
// 会被静态目录以 `image/png` 之外的类型回放。
func (s *FileService) Upload(ctx context.Context, data []byte) (*UploadedFile, error) {
	if len(data) == 0 {
		return nil, apperr.New(apperr.CodeValidationFailed, "").WithFieldErrors(map[string]string{
			"file": "请选择图片文件",
		})
	}
	if int64(len(data)) > s.maxBytes {
		return nil, apperr.New(apperr.CodeFileTooLarge, "").WithDetail("maxBytes", s.maxBytes)
	}

	info, err := imageproc.Inspect(data, s.maxPixels)
	if err != nil {
		if errors.Is(err, imageproc.ErrImageTooLarge) {
			return nil, apperr.New(apperr.CodeFileTooLarge, "").
				WithDetail("maxPixels", s.maxPixels)
		}
		return nil, apperr.Wrap(apperr.CodeFileTypeNotAllowed, err)
	}
	ext, ok := imageproc.ExtensionFor(info.Format)
	if !ok {
		return nil, apperr.Wrap(apperr.CodeFileTypeNotAllowed, imageproc.ErrUnsupportedImage)
	}

	// 文件名用纯随机量而不是 ULID：ULID 前 48 位是时间戳，同一毫秒内的
	// 文件可以按时间猜出来，而这里的 URL 是**唯一**的访问凭证。
	uid := id.Random()
	key := fmt.Sprintf("file_%s%s", uid, ext)
	url, err := s.store.Save(ctx, key, data)
	if err != nil {
		return nil, apperr.Wrap(apperr.CodeInternalError, err)
	}
	return &UploadedFile{
		UID:    uid,
		URL:    url,
		Width:  info.Width,
		Height: info.Height,
		Format: info.Format,
		Bytes:  int64(len(data)),
	}, nil
}
