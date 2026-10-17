package service

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/woliubang256/wmind/backend/internal/domain"
	"github.com/woliubang256/wmind/backend/internal/imageproc"
	"github.com/woliubang256/wmind/backend/internal/pkg/apperr"
	"github.com/woliubang256/wmind/backend/internal/pkg/id"
	"github.com/woliubang256/wmind/backend/internal/storage"
)

// 头像上传限制（docs/04 §5.2）。
const (
	// DefaultMaxAvatarBytes 是头像文件的大小上限。
	DefaultMaxAvatarBytes = 2 << 20
	// maxNicknameRunes 与注册校验保持一致。
	maxNicknameRunes = 32
)

// ProfileUpdate 是修改个人资料的入参。
//
// 字段用指针区分「没传」与「传了空值」：昵称传空串是合法的（清空昵称），
// 而没传则应该保持原值。用值类型做不到这个区分。
type ProfileUpdate struct {
	Nickname *string
	Email    *string
}

// UserServiceConfig 是 UserService 的依赖。
type UserServiceConfig struct {
	Avatars        storage.Store
	Tx             domain.TxManager
	MaxAvatarBytes int64
	Now            Clock
}

// UserService 处理用户自助操作：改资料、换头像。
//
// 改密码不在这里：它要撤销会话，属于认证策略，放在 AuthService。
type UserService struct {
	users          domain.UserRepo
	avatars        storage.Store
	tx             domain.TxManager
	maxAvatarBytes int64
	now            Clock
}

// NewUserService 构造用户服务。
func NewUserService(users domain.UserRepo, cfg UserServiceConfig) (*UserService, error) {
	if users == nil {
		return nil, errors.New("UserService 需要用户仓储")
	}
	if cfg.MaxAvatarBytes <= 0 {
		cfg.MaxAvatarBytes = DefaultMaxAvatarBytes
	}
	if cfg.Now == nil {
		cfg.Now = SystemClock
	}
	return &UserService{
		users: users, avatars: cfg.Avatars, tx: cfg.Tx,
		maxAvatarBytes: cfg.MaxAvatarBytes, now: cfg.Now,
	}, nil
}

// UpdateProfile 修改昵称与邮箱。
//
// 先做完全部校验再写库，并用一个事务包住两次更新：否则「昵称改成功、
// 邮箱冲突」会留下一个只改了一半的资料。
func (s *UserService) UpdateProfile(ctx context.Context, uid string, in ProfileUpdate) (*domain.User, error) {
	user, err := s.users.GetByUID(ctx, uid)
	if err != nil {
		return nil, mapUserError(err)
	}

	nickname := user.Nickname
	if in.Nickname != nil {
		nickname = strings.TrimSpace(*in.Nickname)
		if len([]rune(nickname)) > maxNicknameRunes {
			return nil, apperr.New(apperr.CodeValidationFailed, "").WithFieldErrors(map[string]string{
				"nickname": fmt.Sprintf("昵称最多 %d 个字符", maxNicknameRunes),
			})
		}
	}

	email := user.Email
	if in.Email != nil {
		email = strings.ToLower(strings.TrimSpace(*in.Email))
		if !emailPattern.MatchString(email) {
			return nil, apperr.New(apperr.CodeValidationFailed, "").WithFieldErrors(map[string]string{
				"email": "邮箱格式不正确",
			})
		}
		if email != user.Email {
			existing, lookupErr := s.users.GetByEmail(ctx, email)
			if lookupErr == nil && existing.ID != user.ID {
				return nil, apperr.New(apperr.CodeAuthEmailTaken, "")
			}
			if lookupErr != nil && !errors.Is(lookupErr, domain.ErrNotFound) {
				return nil, apperr.Wrap(apperr.CodeInternalError, lookupErr)
			}
		}
	}

	if nickname == user.Nickname && email == user.Email {
		return user, nil
	}

	apply := func(ctx context.Context) error {
		now := s.now()
		if nickname != user.Nickname {
			updated, updateErr := s.users.UpdateProfile(ctx, domain.UpdateProfileInput{
				UID: uid, Nickname: nickname, AvatarURL: user.AvatarURL, Now: now,
			})
			if updateErr != nil {
				return mapUserError(updateErr)
			}
			user = updated
		}
		if email != user.Email {
			updated, updateErr := s.users.UpdateEmail(ctx, uid, email, now)
			if updateErr != nil {
				if errors.Is(updateErr, domain.ErrDuplicate) {
					// 并发改邮箱：先查后写之间的窗口被另一个请求穿过了。
					return apperr.New(apperr.CodeAuthEmailTaken, "")
				}
				return mapUserError(updateErr)
			}
			user = updated
		}
		return nil
	}

	if s.tx == nil {
		if err := apply(ctx); err != nil {
			return nil, err
		}
		return user, nil
	}
	if err := s.tx.WithTx(ctx, apply); err != nil {
		return nil, err
	}
	return user, nil
}

// UpdateAvatar 保存新头像并返回更新后的用户。
//
// 判定「是不是图片」靠解码而不是 Content-Type：后者由客户端提供，
// 可以随便写。
func (s *UserService) UpdateAvatar(ctx context.Context, uid string, data []byte) (*domain.User, error) {
	if len(data) == 0 {
		return nil, apperr.New(apperr.CodeValidationFailed, "").WithFieldErrors(map[string]string{
			"file": "请选择图片文件",
		})
	}
	if int64(len(data)) > s.maxAvatarBytes {
		return nil, apperr.New(apperr.CodeFileTooLarge, "").
			WithDetail("maxBytes", s.maxAvatarBytes)
	}
	if s.avatars == nil {
		return nil, apperr.New(apperr.CodeServiceUnavailable, "")
	}

	encoded, err := imageproc.SquareAvatar(data, imageproc.AvatarSize)
	if err != nil {
		return nil, apperr.Wrap(apperr.CodeFileTypeNotAllowed, err)
	}

	user, err := s.users.GetByUID(ctx, uid)
	if err != nil {
		return nil, mapUserError(err)
	}

	// 文件名带 ULID：同一用户连续上传不会互相覆盖（时间戳在同一毫秒内会撞），
	// 旧文件随后删除。
	key := fmt.Sprintf("avatar_%s_%s.png", uid, id.New())
	url, err := s.avatars.Save(ctx, key, encoded)
	if err != nil {
		return nil, apperr.Wrap(apperr.CodeInternalError, err)
	}

	updated, err := s.users.UpdateProfile(ctx, domain.UpdateProfileInput{
		UID: uid, Nickname: user.Nickname, AvatarURL: url, Now: s.now(),
	})
	if err != nil {
		// 写库失败就把刚存的文件删掉，避免磁盘里堆孤儿文件。
		_ = s.avatars.Delete(ctx, key)
		return nil, mapUserError(err)
	}

	s.deletePreviousAvatar(ctx, user.AvatarURL)
	return updated, nil
}

// deletePreviousAvatar 删除上一张由本服务托管的头像。
//
// 只删自己前缀下的文件：AvatarURL 也可能指向外部地址（二期对象存储），
// 那种值不该被当成键去删。
func (s *UserService) deletePreviousAvatar(ctx context.Context, previousURL string) {
	if previousURL == "" || s.avatars == nil {
		return
	}
	prefix := s.avatars.URL("")
	if !strings.HasPrefix(previousURL, prefix) {
		return
	}
	key := strings.TrimPrefix(previousURL, prefix)
	if key == "" {
		return
	}
	_ = s.avatars.Delete(ctx, key)
}

func mapUserError(err error) error {
	if errors.Is(err, domain.ErrNotFound) {
		return apperr.New(apperr.CodeAuthTokenInvalid, "")
	}
	if errors.Is(err, domain.ErrDuplicate) {
		return apperr.New(apperr.CodeAuthEmailTaken, "")
	}
	return apperr.Wrap(apperr.CodeInternalError, err)
}
