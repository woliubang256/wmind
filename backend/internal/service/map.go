package service

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/woliubang256/wmind/backend/internal/domain"
	"github.com/woliubang256/wmind/backend/internal/pkg/apperr"
	"github.com/woliubang256/wmind/backend/internal/pkg/id"
)

const (
	// DefaultMaxDocumentBytes 是单份 .wmind 文档的大小上限。
	//
	// 8 MiB 是量出来的：2000 节点的导图（含样式与备注）序列化后约 1.2 MB，
	// 8 MiB 给足了 6 倍余量。上限存在的意义不是「省空间」而是「拒绝病态输入」——
	// 没有它，一个 500 MB 的 PUT 会先把内存吃满再进校验。
	DefaultMaxDocumentBytes int64 = 8 << 20

	// maxMapTitleRunes 与前端标题输入框的软限制一致。
	maxMapTitleRunes = 200

	// maxDocumentDepth 是文档树的最大深度。
	//
	// 解析是递归的，恶意构造的 10 万层嵌套会直接打爆栈（Go 的栈溢出是
	// 进程级崩溃，recover 兜不住）。正常导图深度不会超过 20 层。
	maxDocumentDepth = 512
)

// docEnvelope 是服务端关心的 .wmind 信封字段。
//
// 只解析这几个字段，不把整份文档反序列化成强类型：文档里的大量样式、
// 备注、扩展字段前端才是权威，服务端多解一层就多一处「服务端版本落后于
// 前端」的耦合。这里的目的只是**拒绝明显不是导图的东西**。
type docEnvelope struct {
	Format        string `json:"format"`
	FormatVersion string `json:"formatVersion"`
	ID            string `json:"id"`
	Title         string `json:"title"`
	Sheets        []struct {
		RootTopic      *docTopic  `json:"rootTopic"`
		FloatingTopics []docTopic `json:"floatingTopics"`
	} `json:"sheets"`
}

type docTopic struct {
	ID       string `json:"id"`
	Title    string `json:"title"`
	Children struct {
		Attached []docTopic `json:"attached"`
		Detached []docTopic `json:"detached"`
	} `json:"children"`
}

// countNodes 数节点总数（含折叠的后代）。
func countNodes(topic *docTopic, depth int) int {
	if topic == nil || depth > maxDocumentDepth {
		return 0
	}
	total := 1
	for i := range topic.Children.Attached {
		total += countNodes(&topic.Children.Attached[i], depth+1)
	}
	for i := range topic.Children.Detached {
		total += countNodes(&topic.Children.Detached[i], depth+1)
	}
	return total
}

// validateDocument 校验并统计节点数。
func validateDocument(raw []byte) (int, error) {
	var doc docEnvelope
	if err := json.Unmarshal(raw, &doc); err != nil {
		return 0, apperr.New(apperr.CodeDocumentInvalid, "").
			WithDetail("reason", "文档不是合法的 JSON")
	}
	if doc.Format != "wmind" {
		return 0, apperr.New(apperr.CodeDocumentInvalid, "").
			WithDetail("reason", "format 必须是 wmind")
	}
	if len(doc.Sheets) == 0 {
		return 0, apperr.New(apperr.CodeDocumentInvalid, "").
			WithDetail("reason", "文档至少需要一张画布")
	}

	total := 0
	for i := range doc.Sheets {
		total += countNodes(doc.Sheets[i].RootTopic, 0)
		for j := range doc.Sheets[i].FloatingTopics {
			total += countNodes(&doc.Sheets[i].FloatingTopics[j], 0)
		}
	}
	if total == 0 {
		return 0, apperr.New(apperr.CodeDocumentInvalid, "").
			WithDetail("reason", "文档没有中心主题")
	}
	return total, nil
}

// CreateMapInput 是创建导图的入参。
type CreateMapInput struct {
	Title    string
	Document []byte
	OwnerID  int64
}

// SaveMapInput 是全量保存的入参。
type SaveMapInput struct {
	Version  int
	Title    string
	Document []byte
}

// MapLimits 是 MapService 需要从站点设置里读的限制。
//
// 用接口而不是直接依赖 settings 包：service 层不该知道设置是怎么存的，
// 测试里也给得出一个返回固定值的实现。
type MapLimits interface {
	MapsPerUser() int
}

type TrashPolicy interface {
	TrashRetentionDays() int
}

// MapServiceConfig 是 MapService 的依赖。
type MapServiceConfig struct {
	Maps             domain.MapRepo
	Limits           MapLimits
	TrashPolicy      TrashPolicy
	Now              Clock
	MaxDocumentBytes int64
}

// MapService 处理导图的增删改查。
//
// 它**不做**渲染、不做导入导出、不做分享：这些各自有独立的服务，
// 混在一起会让「保存」这条最热的路径背上无关依赖。
type MapService struct {
	maps             domain.MapRepo
	limits           MapLimits
	trashPolicy      TrashPolicy
	now              Clock
	maxDocumentBytes int64
}

// NewMapService 构造导图服务。
func NewMapService(cfg MapServiceConfig) (*MapService, error) {
	if cfg.Maps == nil {
		return nil, errors.New("MapService 需要导图仓储")
	}
	if cfg.Now == nil {
		cfg.Now = SystemClock
	}
	if cfg.MaxDocumentBytes <= 0 {
		cfg.MaxDocumentBytes = DefaultMaxDocumentBytes
	}
	return &MapService{
		maps: cfg.Maps, limits: cfg.Limits, trashPolicy: cfg.TrashPolicy, now: cfg.Now,
		maxDocumentBytes: cfg.MaxDocumentBytes,
	}, nil
}

// List 返回某人的导图列表（不含 document）。
//
// 仓储返回的是完整行（含 document），这里不清空它：列表接口的 DTO 本来
// 就不带 document 字段，让 SQL 少查一列的收益远小于多一条查询路径的维护成本。
//
// sort 是已经解析过的枚举，不是原始字符串：解析放在 handler 边界上做一次，
// 服务层拿到的值必然合法，仓储层就不需要再防御一遍。
func (s *MapService) List(ctx context.Context, ownerID int64, keyword string, sort domain.MapSort, page, pageSize int) ([]*domain.Map, int64, error) {
	p := domain.NewPage(page, pageSize)
	keyword = strings.TrimSpace(keyword)

	if keyword == "" {
		maps, err := s.maps.ListByOwner(ctx, ownerID, sort, p)
		if err != nil {
			return nil, 0, mapMapError(err)
		}
		total, err := s.maps.CountByOwner(ctx, ownerID)
		if err != nil {
			return nil, 0, mapMapError(err)
		}
		return maps, total, nil
	}

	pattern := "%" + escapeLike(keyword) + "%"
	maps, err := s.maps.SearchByTitle(ctx, ownerID, pattern, sort, p)
	if err != nil {
		return nil, 0, mapMapError(err)
	}
	total, err := s.maps.CountByTitle(ctx, ownerID, pattern)
	if err != nil {
		return nil, 0, mapMapError(err)
	}
	return maps, total, nil
}

// escapeLike 转义 LIKE 的通配符。
//
// 不转义的话，用户搜 "100%" 会匹配到所有标题以 100 开头的内容——
// 看起来像搜索坏了，其实是 % 被当成了通配符。
func escapeLike(input string) string {
	replacer := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
	return replacer.Replace(input)
}

// Create 新建导图。
func (s *MapService) Create(ctx context.Context, ownerID int64, in CreateMapInput) (*domain.Map, error) {
	if s.limits != nil {
		limit := s.limits.MapsPerUser()
		if limit > 0 {
			count, err := s.maps.CountByOwner(ctx, ownerID)
			if err != nil {
				return nil, mapMapError(err)
			}
			if count >= int64(limit) {
				return nil, apperr.New(apperr.CodeMapLimitReached, "").WithDetail("limit", limit)
			}
		}
	}

	if int64(len(in.Document)) > s.maxDocumentBytes {
		return nil, apperr.New(apperr.CodeDocumentTooLarge, "").WithDetail("maxBytes", s.maxDocumentBytes)
	}
	nodeCount, err := validateDocument(in.Document)
	if err != nil {
		return nil, err
	}

	title := normalizeTitle(in.Title)
	now := s.now()
	created, err := s.maps.Create(ctx, domain.CreateMapInput{
		UID:       id.New(),
		OwnerID:   ownerID,
		Title:     title,
		Document:  in.Document,
		NodeCount: nodeCount,
		SizeBytes: int64(len(in.Document)),
		Now:       now,
	})
	if err != nil {
		return nil, mapMapError(err)
	}
	return created, nil
}

// Get 读取完整导图。
func (s *MapService) Get(ctx context.Context, uid string, ownerID int64) (*domain.Map, error) {
	// uid 为空直接当「不存在」：某些路由参数缺失时会传进来空串，
	// 让它走到仓储去查一个空 uid 是浪费，而且日志里会多一条噪音。
	if strings.TrimSpace(uid) == "" {
		return nil, apperr.New(apperr.CodeMapNotFound, "")
	}
	found, err := s.maps.GetByUID(ctx, uid, ownerID)
	if err != nil {
		return nil, mapMapError(err)
	}
	return found, nil
}

// Save 全量保存（编辑器的自动保存走这里）。
//
// 乐观锁的冲突处理是这段代码的核心：版本不匹配时**再读一次**当前版本塞进
// details，前端据此显示「你的版本 v12、服务器 v15」。不回读的话前端只知道
// 「冲突了」，不知道差多少，也就无法判断该覆盖还是该另存。
func (s *MapService) Save(ctx context.Context, uid string, ownerID int64, in SaveMapInput) (*domain.Map, error) {
	if int64(len(in.Document)) > s.maxDocumentBytes {
		return nil, apperr.New(apperr.CodeDocumentTooLarge, "").WithDetail("maxBytes", s.maxDocumentBytes)
	}
	nodeCount, err := validateDocument(in.Document)
	if err != nil {
		return nil, err
	}

	saved, err := s.maps.UpdateWithVersion(ctx, domain.UpdateMapInput{
		UID:             uid,
		OwnerID:         ownerID,
		Title:           normalizeTitle(in.Title),
		Document:        in.Document,
		NodeCount:       nodeCount,
		SizeBytes:       int64(len(in.Document)),
		ExpectedVersion: in.Version,
		Now:             s.now(),
	})
	if err == nil {
		return saved, nil
	}

	if errors.Is(err, domain.ErrVersionConflict) {
		current, lookupErr := s.maps.GetByUID(ctx, uid, ownerID)
		if lookupErr != nil {
			return nil, mapMapError(lookupErr)
		}
		return nil, apperr.New(apperr.CodeMapVersionConflict, "").
			WithDetail("currentVersion", current.Version).
			WithDetail("currentUpdatedAt", current.UpdatedAt.UTC().Format(time.RFC3339))
	}
	return nil, mapMapError(err)
}

// Rename 只改标题，不动 document。
func (s *MapService) Rename(ctx context.Context, uid string, ownerID int64, title string) (*domain.Map, error) {
	updated, err := s.maps.UpdateMeta(ctx, uid, ownerID, normalizeTitle(title), s.now())
	if err != nil {
		return nil, mapMapError(err)
	}
	return updated, nil
}

// maxThumbnailURLRunes 是缩略图 URL 的长度上限。
//
// 缩略图是 `/uploads/<uid>.png` 这种形态，正常不超过 60 字符。上限存在的
// 意义是别让这一列变成第二个可以存任意文本的地方。
const maxThumbnailURLRunes = 512

// UpdateThumbnail 写入缩略图地址。传空串表示清除。
//
// 只接受**站内相对路径**（以单个 `/` 开头），拒绝任何带 scheme 的值。
// 缩略图最终会进 `<img src>`，而 `javascript:` 之类的伪协议虽然现代浏览器
// 不会在 img 里执行，但这个字段是用户可控的、会被所有列表页渲染的——
// 让它只能指向本站，是成本最低的一条防线。`//evil.com/x.png` 这种协议相对
// URL 一并拒掉，它同样会指到站外。
func (s *MapService) UpdateThumbnail(ctx context.Context, uid string, ownerID int64, thumbnailURL string) error {
	thumbnailURL = strings.TrimSpace(thumbnailURL)
	if thumbnailURL != "" {
		if !strings.HasPrefix(thumbnailURL, "/") || strings.HasPrefix(thumbnailURL, "//") {
			return apperr.New(apperr.CodeValidationFailed, "").WithFieldErrors(map[string]string{
				"thumbnailUrl": "必须是站内相对路径",
			})
		}
		if len([]rune(thumbnailURL)) > maxThumbnailURLRunes {
			return apperr.New(apperr.CodeValidationFailed, "").WithFieldErrors(map[string]string{
				"thumbnailUrl": "地址过长",
			})
		}
	}
	return mapMapError(s.maps.UpdateThumbnail(ctx, uid, ownerID, thumbnailURL, s.now()))
}

// Delete 软删除（进回收站）。
func (s *MapService) Delete(ctx context.Context, uid string, ownerID int64) error {
	return mapMapError(s.maps.SoftDelete(ctx, uid, ownerID, s.now()))
}

// Duplicate 复制导图，标题追加「 - 副本」。
func (s *MapService) Duplicate(ctx context.Context, uid string, ownerID int64) (*domain.Map, error) {
	source, err := s.maps.GetByUID(ctx, uid, ownerID)
	if err != nil {
		return nil, mapMapError(err)
	}
	return s.Create(ctx, ownerID, CreateMapInput{
		Title:    duplicateTitle(source.Title),
		Document: source.Document,
		OwnerID:  ownerID,
	})
}

// TrashRetentionDays reads the current global policy for existing trash too.
func (s *MapService) TrashRetentionDays() int {
	if s.trashPolicy != nil {
		if days := s.trashPolicy.TrashRetentionDays(); days > 0 {
			return days
		}
	}
	return domain.DefaultTrashRetentionDays
}

// ListTrash 返回回收站列表。
func (s *MapService) ListTrash(ctx context.Context, ownerID int64, page, pageSize int) ([]*domain.Map, int64, error) {
	p := domain.NewPage(page, pageSize)
	maps, err := s.maps.ListTrashed(ctx, ownerID, p)
	if err != nil {
		return nil, 0, mapMapError(err)
	}
	total, err := s.maps.CountTrashed(ctx, ownerID)
	if err != nil {
		return nil, 0, mapMapError(err)
	}
	return maps, total, nil
}

// Restore 从回收站恢复。
func (s *MapService) Restore(ctx context.Context, uid string, ownerID int64) (*domain.Map, error) {
	restored, err := s.maps.Restore(ctx, uid, ownerID, s.now())
	if err != nil {
		return nil, mapMapError(err)
	}
	return restored, nil
}

// Purge 彻底删除。
func (s *MapService) Purge(ctx context.Context, uid string, ownerID int64) error {
	return mapMapError(s.maps.HardDelete(ctx, uid, ownerID))
}

// EmptyTrash 清空回收站。
func (s *MapService) EmptyTrash(ctx context.Context, ownerID int64) error {
	return mapMapError(s.maps.HardDeleteTrashed(ctx, ownerID))
}

// normalizeTitle 清理标题并在为空时给出默认值。
func normalizeTitle(title string) string {
	title = strings.TrimSpace(title)
	if title == "" {
		return domain.DefaultMapTitle
	}
	runes := []rune(title)
	if len(runes) > maxMapTitleRunes {
		return string(runes[:maxMapTitleRunes])
	}
	return title
}

// duplicateTitle 生成副本标题。
//
// 截断到上限之内再拼后缀，否则一个刚好 200 字的标题复制后会超限。
func duplicateTitle(title string) string {
	const suffix = " - 副本"
	runes := []rune(title)
	if len(runes)+len([]rune(suffix)) > maxMapTitleRunes {
		runes = runes[:maxMapTitleRunes-len([]rune(suffix))]
	}
	return string(runes) + suffix
}

func mapMapError(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, domain.ErrNotFound):
		return apperr.New(apperr.CodeMapNotFound, "")
	case errors.Is(err, domain.ErrVersionConflict):
		return apperr.New(apperr.CodeMapVersionConflict, "")
	default:
		return apperr.Wrap(apperr.CodeInternalError, err)
	}
}
