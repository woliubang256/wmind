// Command server is wmind's backend entry point.
//
// Responsibilities: load configuration, assemble dependencies, serve HTTP, and
// shut down gracefully. Business logic lives in the modular application layers.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/woliubang256/wmind/backend/internal/auth"
	"github.com/woliubang256/wmind/backend/internal/backup"
	"github.com/woliubang256/wmind/backend/internal/config"
	"github.com/woliubang256/wmind/backend/internal/domain"
	"github.com/woliubang256/wmind/backend/internal/handler"
	"github.com/woliubang256/wmind/backend/internal/httpapi"
	"github.com/woliubang256/wmind/backend/internal/httpapi/middleware"
	"github.com/woliubang256/wmind/backend/internal/migrate"
	"github.com/woliubang256/wmind/backend/internal/pkg/logger"
	postgresrepo "github.com/woliubang256/wmind/backend/internal/repository/postgres"
	sqliterepo "github.com/woliubang256/wmind/backend/internal/repository/sqlite"
	"github.com/woliubang256/wmind/backend/internal/service"
	"github.com/woliubang256/wmind/backend/internal/settings"
	"github.com/woliubang256/wmind/backend/internal/storage"
	"github.com/woliubang256/wmind/backend/internal/trash"
)

// shutdownTimeout is bounded by the container stop_grace_period with 5s spare.
const shutdownTimeout = 15 * time.Second

// errAlreadyReported 表示错误已经自己打印过了（子命令的用法提示等），
// main 只需要退出码，不必再套一层 "startup failed" 前缀——那会让
// `wmind db` 的用法提示看起来像服务启动失败。
var errAlreadyReported = errors.New("already reported")

func main() {
	if err := run(); err != nil {
		if errors.Is(err, errAlreadyReported) {
			os.Exit(1)
		}
		fmt.Fprintf(os.Stderr, "wmind startup failed: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}

	log := logger.New(cfg.LogLevel, cfg.IsProduction())
	slog.SetDefault(log)

	// 一次性子命令（目前只有 `db backup`）在起服务之前处理掉：同一个二进制
	// 既是服务又是运维工具，生产镜像里不需要第二个可执行文件。
	if handled, err := runDBSubcommand(context.Background(), cfg, os.Args[1:], log); handled {
		if err != nil {
			// 子命令的错误自己打印：用法提示套上 "startup failed" 会看不懂。
			fmt.Fprintf(os.Stderr, "wmind: %v\n", err)
			return errAlreadyReported
		}
		return nil
	}

	log.Info("wmind backend starting", cfg.Summary()...)

	startupCtx, startupCancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer startupCancel()
	ready := make([]httpapi.ReadyCheck, 0, 1)
	var closeDatabase func()

	// These are the dialect-agnostic handles the service layer works with.
	// Only this switch is allowed to name a concrete dialect.
	var (
		backupProtectedPaths []string
		backupRepo           domain.BackupRepository
		factorRepo           domain.TwoFactorRepo
		statsRepo            domain.AdminStatsRepo
		userRepo             domain.UserRepo
		tokenRepo            domain.RefreshTokenRepo
		settingsRepo         domain.SettingsRepo
		auditRepo            domain.AuditRepo
		mapRepo              domain.MapRepo
		trashRepo            domain.TrashRepo
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
		closeDatabase = func() { _ = db.Close() }
		if cfg.AutoMigrate {
			if err := migrate.Up(config.DriverSQLite, db, log); err != nil {
				closeDatabase()
				return err
			}
		}
		ready = append(ready, httpapi.ReadyCheck{Name: "database", Ping: sqliterepo.Check(db)})
		backupRepo = sqliterepo.NewBackupRepository(db)
		backupProtectedPaths = append(backupProtectedPaths, cfg.DB.SQLitePath)
		statsRepo = sqliterepo.NewAdminStatsRepository(db)
		factorRepo = sqliterepo.NewTwoFactorRepository(db)
		userRepo = sqliterepo.NewUserRepository(db)
		tokenRepo = sqliterepo.NewRefreshTokenRepository(db)
		settingsRepo = sqliterepo.NewSettingsRepository(db)
		auditRepo = sqliterepo.NewAuditRepository(db)
		mapRepo = sqliterepo.NewMapRepository(db)
		trashRepo = sqliterepo.NewTrashRepository(db)
		themeRepo = sqliterepo.NewThemeRepository(db)
		templateRepo = sqliterepo.NewTemplateRepository(db)
		shareRepo = sqliterepo.NewShareRepository(db)
		txManager = sqliterepo.NewTxManager(db)

	case config.DriverPostgres:
		pool, err := postgresrepo.Connect(startupCtx, cfg.DB.URL, cfg.DB.MaxConns)
		if err != nil {
			return fmt.Errorf("connect PostgreSQL: %w", err)
		}
		closeDatabase = pool.Close
		migrationDB, err := postgresrepo.OpenForMigration(cfg.DB.URL)
		if err != nil {
			closeDatabase()
			return err
		}
		if cfg.AutoMigrate {
			if err := migrate.Up(config.DriverPostgres, migrationDB, log); err != nil {
				_ = migrationDB.Close()
				closeDatabase()
				return err
			}
		}
		if err := migrationDB.Close(); err != nil {
			closeDatabase()
			return fmt.Errorf("close PostgreSQL migration connection: %w", err)
		}
		ready = append(ready, httpapi.ReadyCheck{Name: "database", Ping: postgresrepo.Check(pool)})
		backupRepo = postgresrepo.NewBackupRepository(pool)
		statsRepo = postgresrepo.NewAdminStatsRepository(pool)
		factorRepo = postgresrepo.NewTwoFactorRepository(pool)
		userRepo = postgresrepo.NewUserRepository(pool)
		tokenRepo = postgresrepo.NewRefreshTokenRepository(pool)
		settingsRepo = postgresrepo.NewSettingsRepository(pool)
		auditRepo = postgresrepo.NewAuditRepository(pool)
		mapRepo = postgresrepo.NewMapRepository(pool)
		trashRepo = postgresrepo.NewTrashRepository(pool)
		themeRepo = postgresrepo.NewThemeRepository(pool)
		templateRepo = postgresrepo.NewTemplateRepository(pool)
		shareRepo = postgresrepo.NewShareRepository(pool)
		txManager = postgresrepo.NewTxManager(pool)

	default:
		return fmt.Errorf("unsupported database driver %q", cfg.DB.Driver)
	}
	defer closeDatabase()

	issuer, err := auth.NewTokenIssuer(cfg.Auth.JWTSecret, cfg.Auth.AccessTTL)
	if err != nil {
		return err
	}

	settingsSvc, err := settings.New(settingsRepo, settings.Config{Logger: log, Tx: txManager})
	if err != nil {
		return err
	}
	// 读不到设置不阻断启动：站点用默认值起来，管理员登录后台就能发现并修。
	// Load 内部已经打了 ERROR 日志。
	_ = settingsSvc.Load(startupCtx)
	// TTL 兜底刷新：多实例部署时用来在 60 秒内看到别的实例改过的设置。
	settingsCtx, stopSettings := context.WithCancel(context.Background())
	defer stopSettings()
	go settingsSvc.Run(settingsCtx)
	warnRiskySettings(settingsSvc, log)

	factorKey := cfg.Auth.TwoFactorKey
	if factorKey == "" {
		factorKey = cfg.Auth.JWTSecret
	}
	authSvc, err := service.NewAuthService(userRepo, tokenRepo, txManager, service.AuthServiceConfig{
		TwoFactor: factorRepo, TwoFactorKey: factorKey,
		Issuer:       issuer,
		RefreshTTL:   cfg.Auth.RefreshTTL,
		Site:         settingsSvc,
		UserCacheTTL: 60 * time.Second,
	})
	if err != nil {
		return err
	}

	seeded, err := authSvc.SeedAdmin(startupCtx, cfg.Admin.Email, cfg.Admin.Password)
	if err != nil {
		// A bad seed password must not stop the server: the operator can fix the
		// environment variable and restart, and an existing admin can still log in.
		log.Warn("seed admin skipped", "err", err)
	} else if seeded {
		log.Info("seed admin created", "email", cfg.Admin.Email)
	}

	avatarStore, err := storage.NewLocalStore(cfg.Storage.Dir, "/uploads")
	if err != nil {
		return err
	}
	userSvc, err := service.NewUserService(userRepo, service.UserServiceConfig{
		Avatars: avatarStore, Tx: txManager,
	})
	if err != nil {
		return err
	}

	// 通用图片上传复用同一个存储实现（同一个目录、同一个 /uploads 前缀）：
	// 头像与导入图片的差别只在「要不要裁剪」，落盘方式一模一样。
	fileSvc, err := service.NewFileService(service.FileServiceConfig{Store: avatarStore})
	if err != nil {
		return err
	}

	adminSvc, err := service.NewAdminService(service.AdminServiceConfig{
		Stats: statsRepo, Uploads: avatarStore,
		Users: userRepo, Tokens: tokenRepo, Audit: auditRepo,
		Site: settingsSvc, Invalidator: authSvc, Tx: txManager, Logger: log,
	})
	if err != nil {
		return err
	}

	mapSvc, err := service.NewMapService(service.MapServiceConfig{
		Maps: mapRepo, Limits: settingsSvc, TrashPolicy: settingsSvc,
	})
	if err != nil {
		return err
	}

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
	shareSvc, err := service.NewShareService(service.ShareServiceConfig{
		Shares: shareRepo, Maps: mapRepo, Policy: settingsSvc,
		Tokens: shareTokens,
		Views:  service.NewViewDeduper(service.DefaultShareViewWindow, nil),
	})
	if err != nil {
		return err
	}

	backupsCtx, stopBackups := context.WithCancel(context.Background())
	backups, err := backup.NewManager(backupsCtx, backup.ManagerConfig{
		ProtectedPaths: backupProtectedPaths, Repository: backupRepo, Settings: settingsRepo, UploadDir: cfg.Storage.Dir, Secret: factorKey, Logger: log,
		AfterRestore: func(ctx context.Context) error { authSvc.InvalidateAllUsers(); return settingsSvc.Reload(ctx) },
	})
	if err != nil {
		stopBackups()
		return fmt.Errorf("initialize backup service: %w", err)
	}
	backupsDone := make(chan struct{})
	defer func() { stopBackups(); <-backupsDone; backups.Wait() }()
	go func() { defer close(backupsDone); backups.Run(backupsCtx) }()

	trashCleaner, err := trash.New(trash.Config{
		Repository: trashRepo, Policy: settingsSvc, Gate: backups.Gate(), Logger: log,
	})
	if err != nil {
		return fmt.Errorf("initialize trash cleaner: %w", err)
	}
	trashDone := make(chan struct{})
	defer func() { stopBackups(); <-trashDone }()
	go func() { defer close(trashDone); trashCleaner.Run(backupsCtx) }()

	cookie := handler.DefaultCookieConfig(cfg.IsProduction(), cfg.Auth.RefreshTTL)
	authHandler := handler.NewAuthHandler(
		authSvc,
		cookie,
		middleware.NewRateLimiter(5, time.Minute, 5),
	)

	router := httpapi.NewRouter(httpapi.Deps{
		Config: cfg, Logger: log, Ready: ready,
		Auth: authHandler, Sessions: authSvc,
		// 关闭注册时让 /auth/register 在限流器之前就返回 403：关站期间的
		// 探测不该消耗 IP 的注册配额，也不该报成「请求太频繁」。
		RegistrationOpen: settingsSvc.RegistrationEnabled,
		Users:            handler.NewUserHandler(userSvc, authSvc, cookie.Name, service.DefaultMaxAvatarBytes),
		Site:             handler.NewSiteHandler(settingsSvc, config.Version),
		AdminSettings:    handler.NewAdminSettingsHandler(settingsSvc, adminSvc),
		Backups:          handler.NewBackupHandler(backups),
		Maintenance:      backups.Gate(),
		Admin:            handler.NewAdminHandler(adminSvc),
		Maps:             handler.NewMapHandler(mapSvc),
		Themes:           handler.NewThemeHandler(themeSvc),
		Templates:        handler.NewTemplateHandler(templateSvc),
		Files:            handler.NewFileHandler(fileSvc),
		Shares:           handler.NewShareHandler(shareSvc, settingsSvc, adminSvc),
	})
	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           router,
		ReadHeaderTimeout: 10 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	serveErr := make(chan error, 1)
	go func() {
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			serveErr <- err
		}
	}()
	log.Info("HTTP server listening", "addr", cfg.Addr)

	select {
	case err := <-serveErr:
		return fmt.Errorf("HTTP server exited unexpectedly: %w", err)
	case <-ctx.Done():
		log.Info("shutdown signal received")
	}

	stopBackups()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Error("graceful shutdown timed out", "err", err)
	}
	log.Info("server stopped")
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
