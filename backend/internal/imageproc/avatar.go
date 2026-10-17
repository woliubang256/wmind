// Package imageproc 处理上传图片：解码、居中裁剪、缩放、重新编码。
//
// 只做「把任意用户上传变成固定规格头像」这一件事。放在独立包里是为了让
// service 不必关心 image 包的细节，也方便单独测试（构造一张 1×1 PNG 即可）。
package imageproc

import (
	"bytes"
	"errors"
	"fmt"
	"image"
	"image/draw"
	"image/png"

	xdraw "golang.org/x/image/draw"
	// 注册解码器：png/jpeg 由 stdlib 提供，webp 由 x/image 提供。
	_ "golang.org/x/image/webp"
	_ "image/jpeg"
)

// AvatarSize 是头像的最终边长（像素）。
const AvatarSize = 256

// ErrUnsupportedImage 表示输入不是可识别的图片。
//
// 判定依据是「能否解码」，不是 Content-Type 或扩展名——两者都由客户端
// 提供，可以随便伪造。
var ErrUnsupportedImage = errors.New("不支持的图片格式")

// SquareAvatar 把任意尺寸的图片居中裁剪成正方形并缩放为 size×size。
//
// 输出统一为 PNG：WebP 编码需要 cgo 或第三方纯 Go 编码器，而头像只有
// 256×256，PNG 的体积（几十 KB）完全可接受；PNG 还能保留透明通道，
// 用 JPEG 会把透明区域压成黑底。
func SquareAvatar(data []byte, size int) ([]byte, error) {
	if size <= 0 {
		size = AvatarSize
	}
	img, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrUnsupportedImage, err)
	}

	bounds := img.Bounds()
	side := bounds.Dx()
	if bounds.Dy() < side {
		side = bounds.Dy()
	}
	if side <= 0 {
		return nil, ErrUnsupportedImage
	}
	// 居中裁剪：从中心取最大的正方形，避免直接把宽图压扁。
	crop := image.Rect(
		bounds.Min.X+(bounds.Dx()-side)/2,
		bounds.Min.Y+(bounds.Dy()-side)/2,
		bounds.Min.X+(bounds.Dx()-side)/2+side,
		bounds.Min.Y+(bounds.Dy()-side)/2+side,
	)

	dst := image.NewRGBA(image.Rect(0, 0, size, size))
	// 先用背景填充，再把源图画上去：源图若有透明区域，PNG 会保留它，
	// 而 RGBA 的零值是全透明，正好符合「没有底色」的预期。
	draw.Draw(dst, dst.Bounds(), image.Transparent, image.Point{}, draw.Src)
	xdraw.CatmullRom.Scale(dst, dst.Bounds(), img, crop, xdraw.Over, nil)

	var buf bytes.Buffer
	if err := png.Encode(&buf, dst); err != nil {
		return nil, fmt.Errorf("编码头像 PNG: %w", err)
	}
	return buf.Bytes(), nil
}
