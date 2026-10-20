package service

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"unicode/utf8"

	"github.com/woliubang256/wmind/backend/internal/domain"
	"github.com/woliubang256/wmind/backend/internal/pkg/apperr"
	"github.com/woliubang256/wmind/backend/internal/pkg/id"
)

const (
	// maxTemplateNameRunes 与前端模板名输入框一致。
	maxTemplateNameRunes = 64

	// DefaultMaxTemplatesPerUser 是每个用户的模板数量上限。
	//
	// 模板是一份完整的 .wmind 文档，比主题重得多，但它仍然是「几十个起点」
	// 级别的东西。上限存在的意义是防脚本刷表，而不是产品限制。
	DefaultMaxTemplatesPerUser = 50
)

// TemplatePolicy 是模板服务需要的站点策略。
//
// 声明成结构接口而不是直接依赖 settings.Service：service 包不能反向
// import settings（settings 已经在被 handler 与 cmd 装配），靠方法集对上即可。
type TemplatePolicy interface {
	// UserTemplateEnabled 报告站点是否允许用户自建模板。
	//
	// 关掉它不影响内置的 8 个模板：那些是前端包里的静态资源，不经过服务端。
	UserTemplateEnabled() bool
}

// TemplateServiceConfig 是 TemplateService 的依赖。
type TemplateServiceConfig struct {
	Templates  domain.TemplateRepo
	Maps       domain.MapRepo
	Policy     TemplatePolicy
	Now        Clock
	MaxPerUser int
}

// TemplateService 管理用户模板。
//
// 它**不提供**内置的 8 个模板：那些是前端包内的静态资源
// （frontend/src/features/templates/builtin.ts），理由见
// db/queries/shared/templates.sql 的文件头。
type TemplateService struct {
	templates  domain.TemplateRepo
	maps       domain.MapRepo
	policy     TemplatePolicy
	now        Clock
	maxPerUser int
}

// NewTemplateService 构造模板服务。
func NewTemplateService(cfg TemplateServiceConfig) (*TemplateService, error) {
	if cfg.Templates == nil {
		return nil, errors.New("TemplateService 需要模板仓储")
	}
	if cfg.Maps == nil {
		return nil, errors.New("TemplateService 需要导图仓储（另存为模板要读源导图）")
	}
	if cfg.Now == nil {
		cfg.Now = SystemClock
	}
	if cfg.MaxPerUser <= 0 {
		cfg.MaxPerUser = DefaultMaxTemplatesPerUser
	}
	return &TemplateService{
		templates: cfg.Templates, maps: cfg.Maps, policy: cfg.Policy,
		now: cfg.Now, maxPerUser: cfg.MaxPerUser,
	}, nil
}

// CreateFromMapInput 是「另存为模板」的入参。
type CreateFromMapInput struct {
	Name   string
	MapUID string
}

// List 返回某人的全部模板（只有元数据，不含文档）。
func (s *TemplateService) List(ctx context.Context, ownerID int64) ([]*domain.Template, error) {
	if err := s.requireEnabled(); err != nil {
		return nil, err
	}
	templates, err := s.templates.ListByOwner(ctx, ownerID)
	if err != nil {
		return nil, mapTemplateError(err)
	}
	return templates, nil
}

// Get 读取一条模板，含完整文档。
//
// 「用模板新建导图」时前端会调它一次，拿文档去 POST /maps。
func (s *TemplateService) Get(ctx context.Context, ownerID int64, uid string) (*domain.Template, error) {
	if err := s.requireEnabled(); err != nil {
		return nil, err
	}
	if strings.TrimSpace(uid) == "" {
		return nil, apperr.New(apperr.CodeTemplateNotFound, "")
	}
	found, err := s.templates.GetByUID(ctx, uid, ownerID)
	if err != nil {
		return nil, mapTemplateError(err)
	}
	return found, nil
}

// CreateFromMap 把一张导图另存为模板。
//
// 源导图必须存在且属于调用者（回收站里的读不到，`GetMapByUID` 带
// `deleted_at IS NULL`）。文档是**原样复制**而不是引用：模板一旦创建就与
// 源导图解耦，改导图不影响模板，改模板也不影响已经建出来的导图
// （FR-TPL-06）。
func (s *TemplateService) CreateFromMap(ctx context.Context, ownerID int64, in CreateFromMapInput) (*domain.Template, error) {
	if err := s.requireEnabled(); err != nil {
		return nil, err
	}
	name, err := normalizeTemplateName(in.Name)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(in.MapUID) == "" {
		return nil, apperr.New(apperr.CodeValidationFailed, "").WithFieldErrors(map[string]string{
			"mapUid": "请选择要保存为模板的导图",
		})
	}

	count, err := s.templates.CountByOwner(ctx, ownerID)
	if err != nil {
		return nil, mapTemplateError(err)
	}
	if count >= int64(s.maxPerUser) {
		return nil, apperr.New(apperr.CodeTemplateLimitReached, "").
			WithDetail("limit", s.maxPerUser)
	}

	source, err := s.maps.GetByUID(ctx, in.MapUID, ownerID)
	if err != nil {
		// 源导图不存在/不属于自己/在回收站，三种情况都落到同一个错误码：
		// 区分它们等于告诉调用者「这个 uid 存在」。
		return nil, mapMapError(err)
	}

	structure, err := templateStructure(source.Document)
	if err != nil {
		return nil, err
	}

	created, err := s.templates.Create(ctx, domain.CreateTemplateInput{
		UID: id.New(), OwnerID: ownerID, Name: name,
		Category:  domain.TemplateCategoryUser,
		Structure: structure,
		// 复制一份：source.Document 可能指向驱动缓冲区。
		Document:     append([]byte(nil), source.Document...),
		ThumbnailURL: source.ThumbnailURL,
		Now:          s.now(),
	})
	if err != nil {
		return nil, mapTemplateError(err)
	}
	return created, nil
}

// Rename 重命名一条用户模板。
//
// 先读再写：仓储的 UPDATE 带 `is_builtin = false` 谓词，命中 0 行时只能
// 返回 ErrNotFound——那样「改内置模板」会被报成「模板不存在」。多一次往返
// 换来一个准确的错误码，对低频操作是划算的。
func (s *TemplateService) Rename(ctx context.Context, ownerID int64, uid, name string) (*domain.Template, error) {
	if err := s.requireEnabled(); err != nil {
		return nil, err
	}
	normalized, err := normalizeTemplateName(name)
	if err != nil {
		return nil, err
	}
	existing, err := s.templates.GetByUID(ctx, uid, ownerID)
	if err != nil {
		return nil, mapTemplateError(err)
	}
	if existing.IsBuiltin {
		return nil, apperr.New(apperr.CodeTemplateBuiltinReadonly, "")
	}
	updated, err := s.templates.Rename(ctx, domain.RenameTemplateInput{
		UID: uid, OwnerID: ownerID, Name: normalized, Now: s.now(),
	})
	if err != nil {
		return nil, mapTemplateError(err)
	}
	return updated, nil
}

// Delete 删除一条用户模板。
func (s *TemplateService) Delete(ctx context.Context, ownerID int64, uid string) error {
	if err := s.requireEnabled(); err != nil {
		return err
	}
	existing, err := s.templates.GetByUID(ctx, uid, ownerID)
	if err != nil {
		return mapTemplateError(err)
	}
	if existing.IsBuiltin {
		return apperr.New(apperr.CodeTemplateBuiltinReadonly, "")
	}
	if err := s.templates.Delete(ctx, uid, ownerID); err != nil {
		return mapTemplateError(err)
	}
	return nil
}

// requireEnabled 在站点关闭用户模板时拒绝请求。
func (s *TemplateService) requireEnabled() error {
	if s.policy == nil {
		return nil
	}
	if !s.policy.UserTemplateEnabled() {
		return apperr.New(apperr.CodeTemplateDisabled, "")
	}
	return nil
}

// normalizeTemplateName 去空白并校验长度。
func normalizeTemplateName(raw string) (string, error) {
	name := strings.TrimSpace(raw)
	switch {
	case name == "":
		return "", apperr.New(apperr.CodeValidationFailed, "").WithFieldErrors(map[string]string{
			"name": "模板名称不能为空",
		})
	case utf8.RuneCountInString(name) > maxTemplateNameRunes:
		return "", apperr.New(apperr.CodeValidationFailed, "").WithFieldErrors(map[string]string{
			"name": "模板名称最多 64 个字符",
		})
	}
	return name, nil
}

// templateDocumentEnvelope 是服务端从文档里唯一要读的东西。
//
// 只解第一张画布的结构：模板卡片按结构分组/筛选，而把整份文档解成强类型
// 会把「前端给 Topic 加一个字段」变成「后端发一次版」。
type templateDocumentEnvelope struct {
	Sheets []struct {
		Structure string `json:"structure"`
	} `json:"sheets"`
}

// defaultTemplateStructure 是文档里没写结构时的兜底。
//
// 不报错：结构缺失的文档仍然是一份能打开的文档（前端会归一化成 mindmap），
// 为它拒绝「另存为模板」只会让用户对着一个说不清原因的错误。
const defaultTemplateStructure = "mindmap"

// templateStructure 从文档里取出第一张画布的结构。
func templateStructure(document []byte) (string, error) {
	if len(document) == 0 {
		return defaultTemplateStructure, nil
	}
	var envelope templateDocumentEnvelope
	if err := json.Unmarshal(document, &envelope); err != nil {
		return "", apperr.New(apperr.CodeDocumentInvalid, "").WithFieldErrors(map[string]string{
			"mapUid": "源导图的文档不是合法的 JSON",
		})
	}
	if len(envelope.Sheets) == 0 || strings.TrimSpace(envelope.Sheets[0].Structure) == "" {
		return defaultTemplateStructure, nil
	}
	return strings.TrimSpace(envelope.Sheets[0].Structure), nil
}

// mapTemplateError 把仓储错误翻译成对外错误码。
func mapTemplateError(err error) error {
	if errors.Is(err, domain.ErrNotFound) {
		return apperr.New(apperr.CodeTemplateNotFound, "")
	}
	if errors.Is(err, domain.ErrDuplicate) {
		// uid 是 ULID，撞号意味着熵源出了问题，不是用户能修的事。
		return apperr.Wrap(apperr.CodeInternalError, err)
	}
	return err
}
