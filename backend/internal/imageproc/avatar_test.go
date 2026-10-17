package imageproc

import (
	"bytes"
	"errors"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"testing"
)

func encodePNG(t *testing.T, width, height int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, width, height))
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			img.Set(x, y, color.RGBA{R: 10, G: 200, B: 30, A: 255})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatalf("编码 PNG: %v", err)
	}
	return buf.Bytes()
}

func TestSquareAvatarResizesToFixedSize(t *testing.T) {
	for _, tc := range []struct{ width, height int }{
		{640, 480}, {480, 640}, {300, 300}, {1, 1},
	} {
		out, err := SquareAvatar(encodePNG(t, tc.width, tc.height), AvatarSize)
		if err != nil {
			t.Fatalf("%dx%d: %v", tc.width, tc.height, err)
		}
		img, format, err := image.Decode(bytes.NewReader(out))
		if err != nil {
			t.Fatalf("%dx%d 输出无法解码: %v", tc.width, tc.height, err)
		}
		if format != "png" {
			t.Fatalf("输出格式 = %s; 期望 png", format)
		}
		if img.Bounds().Dx() != AvatarSize || img.Bounds().Dy() != AvatarSize {
			t.Fatalf("%dx%d 输出尺寸 = %v; 期望 %d×%d", tc.width, tc.height, img.Bounds().Size(), AvatarSize, AvatarSize)
		}
	}
}

func TestSquareAvatarAcceptsJPEG(t *testing.T) {
	img := image.NewRGBA(image.Rect(0, 0, 200, 120))
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, nil); err != nil {
		t.Fatalf("编码 JPEG: %v", err)
	}
	if _, err := SquareAvatar(buf.Bytes(), AvatarSize); err != nil {
		t.Fatalf("JPEG 输入被拒: %v", err)
	}
}

func TestSquareAvatarRejectsNonImage(t *testing.T) {
	_, err := SquareAvatar([]byte("definitely not an image"), AvatarSize)
	if !errors.Is(err, ErrUnsupportedImage) {
		t.Fatalf("错误 = %v; 期望 ErrUnsupportedImage", err)
	}
}

func TestSquareAvatarDefaultSize(t *testing.T) {
	out, err := SquareAvatar(encodePNG(t, 10, 10), 0)
	if err != nil {
		t.Fatalf("默认尺寸: %v", err)
	}
	img, _, err := image.Decode(bytes.NewReader(out))
	if err != nil || img.Bounds().Dx() != AvatarSize {
		t.Fatalf("默认尺寸输出 = %v, %v", img.Bounds().Size(), err)
	}
}
