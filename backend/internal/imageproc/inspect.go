package imageproc

import (
	"bytes"
	"errors"
	"fmt"
	"image"

	// 注册解码器：png/jpeg/gif 由 stdlib 提供，webp 由 x/image 提供。
	// 与 avatar.go 共用同一个注册表——两边各 import 一份的话，改了白名单
	// 只改一处，另一处就会「明明说支持却解不出来」。
	_ "golang.org/x/image/webp"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
)

// ImageInfo 是「这张图是什么」的结论。
type ImageInfo struct {
	// Format 是标准库的格式名（png / jpeg / gif / webp），来自解码结果
	// 而不是文件名或 Content-Type。
	Format string
	Width  int
	Height int
}

// ErrImageTooLarge 表示像素数超过上限。
var ErrImageTooLarge = errors.New("图片尺寸过大")

// Inspect 只读文件头，返回格式与尺寸。
//
// 用 `image.DecodeConfig` 而不是完整解码：一张 10000×10000 的 PNG 完整解码
// 要几百 MB 内存，而这里只需要宽高。上限按**像素数**卡（而不是字节数）——
// 字节数小、像素数巨大的图（纯色大图）压缩后只有几十 KB，解码却能把进程撑爆。
func Inspect(data []byte, maxPixels int) (ImageInfo, error) {
	cfg, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return ImageInfo{}, fmt.Errorf("%w: %v", ErrUnsupportedImage, err)
	}
	if cfg.Width <= 0 || cfg.Height <= 0 {
		return ImageInfo{}, ErrUnsupportedImage
	}
	if maxPixels > 0 && cfg.Width*cfg.Height > maxPixels {
		return ImageInfo{}, fmt.Errorf("%w: %dx%d", ErrImageTooLarge, cfg.Width, cfg.Height)
	}
	return ImageInfo{Format: format, Width: cfg.Width, Height: cfg.Height}, nil
}

// ExtensionFor 把格式名映射成落盘扩展名。
//
// 只认白名单里的四种。扩展名由**解码结果**决定，绝不取客户端的文件名：
// 那等于让上传者决定我们用哪个 Content-Type 去回放这个文件。
func ExtensionFor(format string) (string, bool) {
	switch format {
	case "png":
		return ".png", true
	case "jpeg":
		return ".jpg", true
	case "gif":
		return ".gif", true
	case "webp":
		return ".webp", true
	default:
		return "", false
	}
}
