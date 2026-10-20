package imageproc

import (
	"bytes"
	"errors"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"testing"
)

func TestInspectReportsFormatAndSize(t *testing.T) {
	cases := []struct {
		name   string
		data   []byte
		format string
		ext    string
	}{
		{"png", encodePNG(t, 30, 20), "png", ".png"},
		{"jpeg", func() []byte {
			var buf bytes.Buffer
			if err := jpeg.Encode(&buf, image.NewRGBA(image.Rect(0, 0, 7, 9)), nil); err != nil {
				t.Fatalf("编码 JPEG: %v", err)
			}
			return buf.Bytes()
		}(), "jpeg", ".jpg"},
		{"gif", func() []byte {
			var buf bytes.Buffer
			img := image.NewPaletted(image.Rect(0, 0, 5, 3), color.Palette{color.Black, color.White})
			if err := gif.Encode(&buf, img, nil); err != nil {
				t.Fatalf("编码 GIF: %v", err)
			}
			return buf.Bytes()
		}(), "gif", ".gif"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			info, err := Inspect(tc.data, 0)
			if err != nil {
				t.Fatalf("Inspect: %v", err)
			}
			if info.Format != tc.format {
				t.Fatalf("Format = %q; 期望 %q", info.Format, tc.format)
			}
			if info.Width <= 0 || info.Height <= 0 {
				t.Fatalf("尺寸不合法: %dx%d", info.Width, info.Height)
			}
			ext, ok := ExtensionFor(info.Format)
			if !ok || ext != tc.ext {
				t.Fatalf("ExtensionFor(%q) = %q,%v; 期望 %q", info.Format, ext, ok, tc.ext)
			}
		})
	}
}

func TestInspectRejectsNonImage(t *testing.T) {
	if _, err := Inspect([]byte("<html>not an image</html>"), 0); !errors.Is(err, ErrUnsupportedImage) {
		t.Fatalf("err = %v; 期望 ErrUnsupportedImage", err)
	}
	if _, err := Inspect(nil, 0); !errors.Is(err, ErrUnsupportedImage) {
		t.Fatalf("空数据 err = %v; 期望 ErrUnsupportedImage", err)
	}
}

func TestInspectEnforcesPixelLimit(t *testing.T) {
	// 按像素而不是字节卡：这张图压缩后只有几 KB，但解码要 4000×4000×4 字节。
	data := encodePNG(t, 4000, 4000)
	if len(data) > 200_000 {
		t.Fatalf("夹具不该这么大（%d 字节）——纯色图应当压得很小", len(data))
	}
	if _, err := Inspect(data, 1_000_000); !errors.Is(err, ErrImageTooLarge) {
		t.Fatalf("err = %v; 期望 ErrImageTooLarge", err)
	}
	// 上限够大时正常通过。
	if _, err := Inspect(data, 20_000_000); err != nil {
		t.Fatalf("上限放宽后仍失败: %v", err)
	}
}

func TestExtensionForRejectsUnknown(t *testing.T) {
	// SVG 刻意不在白名单里：它能内嵌脚本，作为图片回放等于存一个 XSS。
	for _, format := range []string{"svg", "bmp", "tiff", ""} {
		if _, ok := ExtensionFor(format); ok {
			t.Fatalf("ExtensionFor(%q) 应当返回 false", format)
		}
	}
}
