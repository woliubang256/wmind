// Package bootstrap 装配 wmind 的运行时依赖。
//
// 它把「用哪个方言、开哪些后台任务、handler 怎么拼」集中在一处，让
// `cmd/server`（Web 形态）与桌面端（`desktop`）共用同一份装配，
// 差异只留在配置来源、数据目录与身份来源上——业务代码不必为端形态分叉。
//
// 依赖方向与 docs/02 §4 一致：bootstrap → handler/service/repository，
// 它自己不被任何业务包依赖。方言切换仍然只出现在本包的一处 switch 里。
package bootstrap

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/woliubang256/wmind/backend/internal/ai"
	"github.com/woliubang256/wmind/backend/internal/auth"
	"github.com/woliubang256/wmind/backend/internal/backup"
	"github.com/woliubang256/wmind/backend/internal/config"
	"github.com/woliubang256/wmind/backend/internal/domain"
	"github.com/woliubang256/wmind/backend/internal/handler"
	"github.com/woliubang256/wmind/backend/internal/httpapi"
	"github.com/woliubang256/wmind/backend/internal/httpapi/middleware"
	"github.com/woliubang256/wmind/backend/internal/migrate"
	postgresrepo "github.com/woliubang256/wmind/backend/internal/repository/postgres"
	sqliterepo "github.com/woliubang256/wmind/backend/internal/repository/sqlite"
	"github.com/woliubang256/wmind/backend/internal/service"
	"github.com/woliubang256/wmind/backend/internal/settings"
	"github.com/woliubang256/wmind/backend/internal/storage"
	"github.com/woliubang256/wmind/backend/internal/trash"
	"github.com/woliubang256/wmind/backend/internal/uploadgc"
)

// Options 是装配的可选参数。
type Options struct {
	// Logger 为空时由 cfg.LogLevel 与运行环境构造一个。
	Logger *slog.Logger
	// StartupTimeout 限制数据库连接与迁移的时间，默认 30s。
	StartupTimeout time.Duration
	// Prepare 在数据库迁移完成后执行一次，供调用方建自己的表。
	//
	// 桌面端用它建 map_sync 等「只存在于客户端」的表：这些表不该进服务端的
	// 迁移集（那会让 Web 侧多出无用的表，还要维护两套方言的 parity）。
	// 只在 SQLite 方言下调用——桌面端只用 SQLite。
	Prepare func(ctx context.Context, db *sql.DB) error
	// SkipWorkers 不启动后台任务（备份调度、回收站清理、上传资源回收）。
	//
	// 桌面端的 MCP stdio 子进程用得上：它只需要读设置与导图，如果也起一套后台
	// 任务，就会和正在运行的客户端抢同一份数据（备份会被调度两次）。
	SkipWorkers bool
	// Quiet 关掉 gin 的路由表打印。
	//
	// 桌面端把日志写进用户数据目录，启动时刷一屏路由表只会淹没真正有用的
	// 那几行；服务端保持默认（开发环境需要它）。
	Quiet bool
}

// App 是一套装配完成的依赖。
//
// 使用方拿到 Handler 挂到自己的 HTTP 服务器上；进程退出前必须调用 Close，
// 它会按启动的逆序停止后台任务（备份/回收站清理/上传回收/设置刷新）并关闭
// 数据库。Close 可重复调用。
type App struct {
	Config  *config.Config
	Logger  *slog.Logger
	Handler http.Handler
	// Ready 是就绪探针的依赖检查项。
	Ready []httpapi.ReadyCheck

	Backups  *backup.Manager
	Settings *settings.Service
	AI       *ai.Service
	// Auth 是会话服务，桌面端用它生成/校验本地身份令牌。
	Auth *service.AuthService
	// Users 是用户仓储，桌面端用它创建并定位本地用户。
	Users domain.UserRepo
	// Maps 是导图仓储，桌面端的同步引擎用它读写本地副本。
	Maps domain.MapRepo
	// MapService 是导图服务，桌面端的本地 MCP 服务器用它读写导图。
	MapService *service.MapService

	closeOnce     sync.Once
	prepare       func(ctx context.Context, db *sql.DB) error
	closeDatabase func()

	stopSettings context.CancelFunc
	settingsDone chan struct{}
	stopBackups  context.CancelFunc
	// skipWorkers 为真时不启动后台任务（见 Options.SkipWorkers）。
	skipWorkers bool
	backupsDone chan struct{}
	trashDone   chan struct{}
	uploadDone  chan struct{}
}

// New 装配全部依赖。
//
// 任何一步失败都会把已启动的后台任务停掉、把数据库关掉，再返回错误——
// 半启动的进程比启动失败更难排查。
func New(ctx context.Context, cfg *config.Config, opts Options) (*App, error) {
	if cfg == nil {
		return nil, errors.New("bootstrap: config is required")
	}
	log := opts.Logger
	if log == nil {
		return nil, errors.New("bootstrap: logger is required")
	}
	timeout := opts.StartupTimeout
	if timeout <= 0 {
		timeout = 30 * time.Second
	}

	if opts.Quiet {
		gin.SetMode(gin.ReleaseMode)
	}
	app := &App{Config: cfg, Logger: log, prepare: opts.Prepare, skipWorkers: opts.SkipWorkers}

	startupCtx, startupCancel := context.WithTimeout(ctx, timeout)
	defer startupCancel()

	if err := app.assemble(startupCtx); err != nil {
		app.Close()
		return nil, err
	}
	return app, nil
}

// Close 停止后台任务并关闭数据库，按启动的逆序执行。
func (a *App) Close() {
	a.closeOnce.Do(func() {
		// 三个清理任务共用 backupsCtx：取消一次即可，但要各自等到退出，
		// 否则数据库可能在它们写库时被关掉。
		if a.stopBackups != nil {
			a.stopBackups()
		}
		if a.uploadDone != nil {
			<-a.uploadDone
		}
		if a.trashDone != nil {
			<-a.trashDone
		}
		if a.backupsDone != nil {
			<-a.backupsDone
		}
		if a.Backups != nil {
			a.Backups.Wait()
		}
		if a.stopSettings != nil {
			a.stopSettings()
		}
		if a.settingsDone != nil {
			<-a.settingsDone
		}
		if a.closeDatabase != nil {
			a.closeDatabase()
		}
	})
}

// assemble 按 docs/02 §4 的依赖方向逐层构建。
func (a *App) assemble(ctx context.Context) error {
	cfg, log := a.Config, a.Logger
	ready := make([]httpapi.ReadyCheck, 0, 1)

	// These are the dialect-agnostic handles the service layer works with.
	// Only this switch is allowed to name a concrete dialect.
	var (
		backupProtectedPaths []string
		backupRepo           domain.BackupRepository
		factorRepo           domain.TwoFactorRepo
		loginChallengeRepo   domain.LoginChallengeRepo
		statsRepo            domain.AdminStatsRepo
		userRepo             domain.UserRepo
		tokenRepo            domain.RefreshTokenRepo
		settingsRepo         domain.SettingsRepo
		auditRepo            domain.AuditRepo
		mapRepo              domain.MapRepo
		trashRepo            domain.TrashRepo
		uploadReferences     domain.UploadReferencesRepo
		themeRepo            domain.ThemeRepo
		templateRepo         domain.TemplateRepo
		shareRepo            domain.ShareRepo
		txManager            domain.TxManager
	)

	// This is the only server-assembly switch allowed to select a dialect.
	switch cfg.DB.Driver {
	case config.DriverSQLite:
		db, err := sqliterepo.Open(cfg.DB.SQLitePath)
		if err != nil {
			return fmt.Errorf("open SQLite: %w", err)
		}
		a.closeDatabase = func() { _ = db.Close() }
		if cfg.AutoMigrate {
			if err := migrate.Up(config.DriverSQLite, db, log); err != nil {
				return err
			}
		}
		if a.prepare != nil {
			if err := a.prepare(ctx, db); err != nil {
				return fmt.Errorf("prepare client schema: %w", err)
			}
		}
		ready = append(ready, httpapi.ReadyCheck{Name: "database", Ping: sqliterepo.Check(db)})
		backupRepo = sqliterepo.NewBackupRepository(db)
		backupProtectedPaths = append(backupProtectedPaths, cfg.DB.SQLitePath)
		statsRepo = sqliterepo.NewAdminStatsRepository(db)
		factorRepo = sqliterepo.NewTwoFactorRepository(db)
		loginChallengeRepo = sqliterepo.NewLoginChallengeRepository(db)
		userRepo = sqliterepo.NewUserRepository(db)
		tokenRepo = sqliterepo.NewRefreshTokenRepository(db)
		settingsRepo = sqliterepo.NewSettingsRepository(db)
		auditRepo = sqliterepo.NewAuditRepository(db)
		mapRepo = sqliterepo.NewMapRepository(db)
		trashRepo = sqliterepo.NewTrashRepository(db)
		uploadReferences = sqliterepo.NewUploadReferencesRepository(db)
		themeRepo = sqliterepo.NewThemeRepository(db)
		templateRepo = sqliterepo.NewTemplateRepository(db)
		shareRepo = sqliterepo.NewShareRepository(db)
		txManager = sqliterepo.NewTxManager(db)

	case config.DriverPostgres:
		pool, err := postgresrepo.Connect(ctx, cfg.DB.URL, cfg.DB.MaxConns)
		if err != nil {
			return fmt.Errorf("connect PostgreSQL: %w", err)
		}
		a.closeDatabase = pool.Close
		migrationDB, err := postgresrepo.OpenForMigration(cfg.DB.URL)
		if err != nil {
			return err
		}
		if cfg.AutoMigrate {
			if err := migrate.Up(config.DriverPostgres, migrationDB, log); err != nil {
				_ = migrationDB.Close()
				return err
			}
		}
		if err := migrationDB.Close(); err != nil {
			return fmt.Errorf("close PostgreSQL migration connection: %w", err)
		}
		ready = append(ready, httpapi.ReadyCheck{Name: "database", Ping: postgresrepo.Check(pool)})
		backupRepo = postgresrepo.NewBackupRepository(pool)
		statsRepo = postgresrepo.NewAdminStatsRepository(pool)
		factorRepo = postgresrepo.NewTwoFactorRepository(pool)
		loginChallengeRepo = postgresrepo.NewLoginChallengeRepository(pool)
		userRepo = postgresrepo.NewUserRepository(pool)
		tokenRepo = postgresrepo.NewRefreshTokenRepository(pool)
		settingsRepo = postgresrepo.NewSettingsRepository(pool)
		auditRepo = postgresrepo.NewAuditRepository(pool)
		mapRepo = postgresrepo.NewMapRepository(pool)
		trashRepo = postgresrepo.NewTrashRepository(pool)
		uploadReferences = postgresrepo.NewUploadReferencesRepository(pool)
		themeRepo = postgresrepo.NewThemeRepository(pool)
		templateRepo = postgresrepo.NewTemplateRepository(pool)
		shareRepo = postgresrepo.NewShareRepository(pool)
		txManager = postgresrepo.NewTxManager(pool)

	default:
		return fmt.Errorf("unsupported database driver %q", cfg.DB.Driver)
	}

	issuer, err := auth.NewTokenIssuer(cfg.Auth.JWTSecret, cfg.Auth.AccessTTL)
	if err != nil {
		return err
	}

	avatarStore, err := storage.NewLocalStore(cfg.Storage.Dir, "/uploads")
	if err != nil {
		return err
	}

	settingsSvc, err := settings.New(settingsRepo, settings.Config{Logger: log, Tx: txManager, UploadExists: avatarStore.Exists})
	if err != nil {
		return err
	}
	// 读不到设置不阻断启动：站点用默认值起来，管理员登录后台就能发现并修。
	// Load 内部已经打了 ERROR 日志。
	_ = settingsSvc.Load(ctx)
	// TTL 兜底刷新：多实例部署时用来在 60 秒内看到别的实例改过的设置。
	settingsCtx, stopSettings := context.WithCancel(context.Background())
	settingsDone := make(chan struct{})
	a.Settings = settingsSvc
	a.stopSettings = stopSettings
	a.settingsDone = settingsDone
	go func() { defer close(settingsDone); settingsSvc.Run(settingsCtx) }()
	warnRiskySettings(settingsSvc, log)

	factorKey := cfg.Auth.TwoFactorKey
	if factorKey == "" {
		factorKey = cfg.Auth.JWTSecret
	}
	authSvc, err := service.NewAuthService(userRepo, tokenRepo, txManager, service.AuthServiceConfig{
		TwoFactor: factorRepo, TwoFactorKey: factorKey,
		Issuer:     issuer,
		RefreshTTL: cfg.Auth.RefreshTTL,
		Site:       settingsSvc,
	})
	if err != nil {
		return err
	}
	a.Auth = authSvc
	a.Users = userRepo
	a.Maps = mapRepo

	seeded, err := authSvc.SeedAdmin(ctx, cfg.Admin.Email, cfg.Admin.Password)
	if err != nil {
		// A bad seed password must not stop the server: the operator can fix the
		// environment variable and restart, and an existing admin can still log in.
		log.Warn("seed admin skipped", "err", err)
	} else if seeded {
		log.Info("seed admin created", "email", cfg.Admin.Email)
	}

	userSvc, err := service.NewUserService(userRepo, service.UserServiceConfig{
		Avatars: avatarStore, Tx: txManager,
	})
	if err != nil {
		return err
	}

	// 通用图片上传复用同一个存储实现（同一个目录、同一个 /uploads 前缀）：
	// 头像与导入图片的差别只在「要不要裁剪」，落盘方式一模一样。
	fileSvc, err := service.NewFileService(service.FileServiceConfig{Store: avatarStore, Maps: mapRepo, Templates: templateRepo})
	if err != nil {
		return err
	}

	adminSvc, err := service.NewAdminService(service.AdminServiceConfig{
		Stats: statsRepo, Uploads: avatarStore,
		Users: userRepo, Tokens: tokenRepo, Audit: auditRepo,
		Maps: mapRepo, Shares: shareRepo,
		Site: settingsSvc, TwoFactor: factorRepo, Tx: txManager, Logger: log,
	})
	if err != nil {
		return err
	}

	mapSvc, err := service.NewMapService(service.MapServiceConfig{
		Maps: mapRepo, Limits: settingsSvc, TrashPolicy: settingsSvc, Assets: fileSvc,
	})
	if err != nil {
		return err
	}

	aiSvc, err := ai.New(settingsRepo, factorKey)
	if err != nil {
		return err
	}
	a.AI = aiSvc

	themeSvc, err := service.NewThemeService(service.ThemeServiceConfig{
		Themes: themeRepo,
	})
	if err != nil {
		return err
	}

	// 模板服务同时需要导图仓储：「另存为模板」要把源导图的文档复制过来。
	templateSvc, err := service.NewTemplateService(service.TemplateServiceConfig{
		Templates: templateRepo, Maps: mapRepo, Policy: settingsSvc,
	})
	if err != nil {
		return err
	}

	// 分享访问凭证与登录令牌共用同一个密钥，但 iss 不同（见 auth.ShareTokenIssuer），
	// 所以两种令牌在 JWT 校验层就互相拒绝，不会被拿去互换。
	shareTokens, err := auth.NewShareTokenIssuer(cfg.Auth.JWTSecret, auth.DefaultShareAccessTTL)
	if err != nil {
		return err
	}
	sharePasswords, err := auth.NewSharePasswordCipher(factorKey)
	if err != nil {
		return err
	}
	shareSvc, err := service.NewShareService(service.ShareServiceConfig{
		Shares: shareRepo, Maps: mapRepo, Policy: settingsSvc,
		Tokens:    shareTokens,
		Passwords: sharePasswords,
		Views:     service.NewViewDeduper(service.DefaultShareViewWindow, nil),
	})
	if err != nil {
		return err
	}

	backupsCtx, stopBackups := context.WithCancel(context.Background())
	backups, err := backup.NewManager(backupsCtx, backup.ManagerConfig{
		ProtectedPaths: backupProtectedPaths, Repository: backupRepo, Settings: settingsRepo, UploadDir: cfg.Storage.Dir, Secret: factorKey, Logger: log,
		AfterRestore: settingsSvc.Reload,
	})
	if err != nil {
		stopBackups()
		return fmt.Errorf("initialize backup service: %w", err)
	}
	a.Backups = backups
	a.stopBackups = stopBackups
	backupsDone := make(chan struct{})
	a.backupsDone = backupsDone
	if a.skipWorkers {
		// 通道必须立刻关闭：Close 会等它，不关就是死锁。
		close(backupsDone)
	} else {
		go func() { defer close(backupsDone); backups.Run(backupsCtx) }()
	}

	trashCleaner, err := trash.New(trash.Config{
		Repository: trashRepo, Policy: settingsSvc, Gate: backups.Gate(), Logger: log,
	})
	if err != nil {
		return fmt.Errorf("initialize trash cleaner: %w", err)
	}
	trashDone := make(chan struct{})
	a.trashDone = trashDone
	if a.skipWorkers {
		close(trashDone)
	} else {
		go func() { defer close(trashDone); trashCleaner.Run(backupsCtx) }()
	}

	uploadCleaner, err := uploadgc.New(uploadgc.Config{
		Root: cfg.Storage.Dir, References: uploadReferences, Gate: backups.Gate(), Logger: log,
	})
	if err != nil {
		return fmt.Errorf("initialize upload cleaner: %w", err)
	}
	uploadDone := make(chan struct{})
	a.uploadDone = uploadDone
	if a.skipWorkers {
		close(uploadDone)
	} else {
		go func() { defer close(uploadDone); uploadCleaner.Run(backupsCtx) }()
	}

	cookie := handler.DefaultCookieConfig(cfg.IsProduction(), cfg.Auth.RefreshTTL)
	loginEncryption, err := service.NewLoginEncryption(loginChallengeRepo, factorKey)
	if err != nil {
		return fmt.Errorf("initialize login encryption: %w", err)
	}
	authHandler := handler.NewAuthHandler(
		authSvc,
		cookie,
		middleware.NewRateLimiter(5, time.Minute, 5),
		loginEncryption,
	)

	a.Handler = httpapi.NewRouter(httpapi.Deps{
		Config: cfg, Logger: log, Ready: ready,
		Auth: authHandler, Sessions: authSvc,
		// 关闭注册时让 /auth/register 在限流器之前就返回 403：关站期间的
		// 探测不该消耗 IP 的注册配额，也不该报成「请求太频繁」。
		RegistrationOpen: settingsSvc.RegistrationEnabled,
		Users:            handler.NewUserHandler(userSvc, authSvc, cookie, service.DefaultMaxAvatarBytes),
		Site:             handler.NewSiteHandler(settingsSvc, config.Version, aiSvc.Enabled),
		AI:               handler.NewAIHandler(aiSvc, adminSvc),
		AdminSettings:    handler.NewAdminSettingsHandler(settingsSvc, adminSvc),
		Backups:          handler.NewBackupHandler(backups),
		Maintenance:      backups.Gate(),
		Admin:            handler.NewAdminHandler(adminSvc),
		Maps:             handler.NewMapHandler(mapSvc),
		MCP:              handler.NewMCPHandler(settingsSvc, mapSvc, userRepo, config.Version, log),
		Themes:           handler.NewThemeHandler(themeSvc),
		Templates:        handler.NewTemplateHandler(templateSvc),
		Files:            handler.NewFileHandler(fileSvc),
		Media:            handler.NewMediaHandler(fileSvc, authSvc, shareSvc, cfg.Storage.Dir),
		Shares:           handler.NewShareHandler(shareSvc, settingsSvc, adminSvc),
	})
	a.MapService = mapSvc
	a.Ready = ready
	return nil
}

// warnRiskySettings 在启动时提示「配置组合本身有安全风险」。
//
// 这两项都是管理员合法可设的，服务端不该拒绝；但组合起来意味着「互联网上
// 任何人都能注册成管理员」，属于必须让人看见的配置。启动日志是唯一保证
// 会被看到的通道——管理员可能永远不会翻到设置页去看。
func warnRiskySettings(svc *settings.Service, log *slog.Logger) {
	snapshot := svc.Snapshot()
	if snapshot.RegistrationEnabled() && snapshot.DefaultRole() == string(domain.RoleAdmin) {
		log.Warn("注册开放且新用户默认角色为 admin：任何人都可以注册成管理员",
			"auth.registration_enabled", true, "auth.default_role", "admin")
	}
	if !snapshot.RegistrationEnabled() {
		log.Info("站点已关闭注册")
	}
}
