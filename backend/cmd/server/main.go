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
)

// shutdownTimeout is bounded by the container stop_grace_period with 5s spare.
const shutdownTimeout = 15 * time.Second

func main() {
	if err := run(); err != nil {
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
	log.Info("wmind backend starting", cfg.Summary()...)

	startupCtx, startupCancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer startupCancel()
	ready := make([]httpapi.ReadyCheck, 0, 1)
	var closeDatabase func()

	// These are the dialect-agnostic handles the service layer works with.
	// Only this switch is allowed to name a concrete dialect.
	var (
		userRepo     domain.UserRepo
		tokenRepo    domain.RefreshTokenRepo
		settingsRepo domain.SettingsRepo
		auditRepo    domain.AuditRepo
		mapRepo      domain.MapRepo
		txManager    domain.TxManager
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
		userRepo = sqliterepo.NewUserRepository(db)
		tokenRepo = sqliterepo.NewRefreshTokenRepository(db)
		settingsRepo = sqliterepo.NewSettingsRepository(db)
		auditRepo = sqliterepo.NewAuditRepository(db)
		mapRepo = sqliterepo.NewMapRepository(db)
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
		userRepo = postgresrepo.NewUserRepository(pool)
		tokenRepo = postgresrepo.NewRefreshTokenRepository(pool)
		settingsRepo = postgresrepo.NewSettingsRepository(pool)
		auditRepo = postgresrepo.NewAuditRepository(pool)
		mapRepo = postgresrepo.NewMapRepository(pool)
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

	authSvc, err := service.NewAuthService(userRepo, tokenRepo, txManager, service.AuthServiceConfig{
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

	adminSvc, err := service.NewAdminService(service.AdminServiceConfig{
		Users: userRepo, Tokens: tokenRepo, Audit: auditRepo,
		Site: settingsSvc, Invalidator: authSvc, Tx: txManager, Logger: log,
	})
	if err != nil {
		return err
	}

	mapSvc, err := service.NewMapService(service.MapServiceConfig{
		Maps: mapRepo, Limits: settingsSvc,
	})
	if err != nil {
		return err
	}

	cookie := handler.DefaultCookieConfig(cfg.IsProduction(), cfg.Auth.RefreshTTL)
	authHandler := handler.NewAuthHandler(
		authSvc,
		cookie,
		middleware.NewRateLimiter(5, time.Minute, 5),
	)

	router := httpapi.NewRouter(httpapi.Deps{
		Config: cfg, Logger: log, Ready: ready,
		Auth: authHandler, Sessions: authSvc,
		Users:         handler.NewUserHandler(userSvc, authSvc, cookie.Name, service.DefaultMaxAvatarBytes),
		Site:          handler.NewSiteHandler(settingsSvc, config.Version),
		AdminSettings: handler.NewAdminSettingsHandler(settingsSvc, adminSvc),
		Admin:         handler.NewAdminHandler(adminSvc),
		Maps:          handler.NewMapHandler(mapSvc),
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
