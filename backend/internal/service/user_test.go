package service

import (
	"bytes"
	"context"
	"errors"
	"image"
	"image/color"
	"image/png"
	"testing"
	"time"

	"github.com/woliubang256/wmind/backend/internal/domain"
	"github.com/woliubang256/wmind/backend/internal/pkg/apperr"
)

func newUserFixture(t *testing.T) (*UserService, *fakeUserRepo, *fakeStore) {
	t.Helper()
	users := newFakeUserRepo()
	store := newFakeStore()
	now := time.Date(2026, 10, 17, 11, 0, 0, 0, time.UTC)
	svc, err := NewUserService(users, UserServiceConfig{
		Avatars: store, Tx: fakeTxManager{}, Now: func() time.Time { return now },
	})
	if err != nil {
		t.Fatalf("NewUserService: %v", err)
	}
	return svc, users, store
}

func mustSeedUser(t *testing.T, users *fakeUserRepo, username, email string) *domain.User {
	t.Helper()
	user, err := users.Create(context.Background(), domain.CreateUserInput{
		UID: "uid-" + username, Username: username, Email: email, PasswordHash: "hash",
		Nickname: "初始昵称", Role: domain.RoleUser, Status: domain.UserStatusActive,
		Now: time.Date(2026, 10, 17, 11, 0, 0, 0, time.UTC),
	})
	if err != nil {
		t.Fatalf("创建测试用户: %v", err)
	}
	return user
}

func ptr(value string) *string { return &value }

func TestUpdateProfile(t *testing.T) {
	svc, users, _ := newUserFixture(t)
	user := mustSeedUser(t, users, "alice", "alice@example.com")
	ctx := context.Background()

	updated, err := svc.UpdateProfile(ctx, user.UID, ProfileUpdate{Nickname: ptr("  新昵称  ")})
	if err != nil {
		t.Fatalf("UpdateProfile: %v", err)
	}
	if updated.Nickname != "新昵称" || updated.Email != "alice@example.com" {
		t.Fatalf("更新结果 = %#v", updated)
	}

	updated, err = svc.UpdateProfile(ctx, user.UID, ProfileUpdate{Email: ptr("  NEW@Example.com ")})
	if err != nil {
		t.Fatalf("改邮箱: %v", err)
	}
	if updated.Email != "new@example.com" {
		t.Fatalf("邮箱未归一化: %q", updated.Email)
	}

	// 什么都不传 = 不改。
	if _, err := svc.UpdateProfile(ctx, user.UID, ProfileUpdate{}); err != nil {
		t.Fatalf("空更新: %v", err)
	}
}

func TestUpdateProfileValidation(t *testing.T) {
	svc, users, _ := newUserFixture(t)
	user := mustSeedUser(t, users, "alice", "alice@example.com")
	mustSeedUser(t, users, "bob", "bob@example.com")
	ctx := context.Background()

	_, err := svc.UpdateProfile(ctx, user.UID, ProfileUpdate{Email: ptr("not-an-email")})
	appErr := requireCode(t, err, apperr.CodeValidationFailed)
	if fields, _ := appErr.Details["fields"].(map[string]string); fields["email"] == "" {
		t.Fatalf("缺少 email 字段错误: %#v", appErr.Details)
	}

	_, err = svc.UpdateProfile(ctx, user.UID, ProfileUpdate{Email: ptr("BOB@example.com")})
	requireCode(t, err, apperr.CodeAuthEmailTaken)

	long := string(make([]rune, 33))
	_, err = svc.UpdateProfile(ctx, user.UID, ProfileUpdate{Nickname: &long})
	requireCode(t, err, apperr.CodeValidationFailed)
}

func TestUpdateProfileUnknownUser(t *testing.T) {
	svc, _, _ := newUserFixture(t)
	_, err := svc.UpdateProfile(context.Background(), "missing", ProfileUpdate{Nickname: ptr("x")})
	requireCode(t, err, apperr.CodeAuthTokenInvalid)
}

// testPNG 生成一张纯色 PNG，用于头像测试。
func testPNG(t *testing.T, width, height int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, width, height))
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			img.Set(x, y, color.RGBA{R: uint8(x % 256), G: uint8(y % 256), B: 128, A: 255})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatalf("生成测试图片: %v", err)
	}
	return buf.Bytes()
}

func TestUpdateAvatar(t *testing.T) {
	svc, users, store := newUserFixture(t)
	user := mustSeedUser(t, users, "alice", "alice@example.com")
	ctx := context.Background()

	first, err := svc.UpdateAvatar(ctx, user.UID, testPNG(t, 640, 480))
	if err != nil {
		t.Fatalf("上传头像: %v", err)
	}
	if first.AvatarURL == "" {
		t.Fatal("头像 URL 为空")
	}
	key := first.AvatarURL[len("/uploads/"):]
	if _, ok := store.files[key]; !ok {
		t.Fatalf("文件未落盘: %v", store.files)
	}

	// 再传一次：新文件写入，旧文件交给引用感知回收，可能仍是站点 Logo 或导图图片。
	second, err := svc.UpdateAvatar(ctx, user.UID, testPNG(t, 100, 100))
	if err != nil {
		t.Fatalf("再次上传头像: %v", err)
	}
	if second.AvatarURL == first.AvatarURL {
		t.Fatal("新头像应使用不同的文件名")
	}
	if len(store.deleted) != 0 || store.files[key] == nil {
		t.Fatalf("头像替换不能直接删除仍可能被引用的旧文件: %v", store.deleted)
	}
}

func TestUpdateAvatarRejectsBadInput(t *testing.T) {
	svc, users, _ := newUserFixture(t)
	user := mustSeedUser(t, users, "alice", "alice@example.com")
	ctx := context.Background()

	if _, err := svc.UpdateAvatar(ctx, user.UID, nil); err == nil {
		t.Fatal("空文件应被拒绝")
	}

	_, err := svc.UpdateAvatar(ctx, user.UID, bytes.Repeat([]byte("x"), int(DefaultMaxAvatarBytes)+1))
	requireCode(t, err, apperr.CodeFileTooLarge)

	_, err = svc.UpdateAvatar(ctx, user.UID, []byte("this is not an image"))
	requireCode(t, err, apperr.CodeFileTypeNotAllowed)
}

type rejectedAvatarWrite struct{ domain.UserRepo }

func (r rejectedAvatarWrite) UpdateProfile(context.Context, domain.UpdateProfileInput) (*domain.User, error) {
	return nil, errors.New("profile write unavailable")
}

func TestRejectedAvatarWriteRemovesOnlyNewUpload(t *testing.T) {
	svc, users, store := newUserFixture(t)
	user := mustSeedUser(t, users, "alice", "alice@example.com")
	first, err := svc.UpdateAvatar(t.Context(), user.UID, testPNG(t, 8, 8))
	if err != nil {
		t.Fatal(err)
	}
	failing, err := NewUserService(rejectedAvatarWrite{UserRepo: users}, UserServiceConfig{Avatars: store})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := failing.UpdateAvatar(t.Context(), user.UID, testPNG(t, 16, 16)); err == nil {
		t.Fatal("expected database failure")
	}
	key := first.AvatarURL[len("/uploads/"):]
	if len(store.files) != 1 || store.files[key] == nil || len(store.deleted) != 1 || store.deleted[0] == key {
		t.Fatalf("failed update must retain current avatar and remove the new upload: files=%d deleted=%v", len(store.files), store.deleted)
	}
}
