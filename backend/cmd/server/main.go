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

	// These three are the dialect-agnostic handles the service layer works with.
	// Only this switch is allowed to name a concrete dialect.
	var (
		userRepo  domain.UserRepo
		tokenRepo domain.RefreshTokenRepo
		txManager domain.TxManager
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
		txManager = postgresrepo.NewTxManager(pool)

	default:
		return fmt.Errorf("unsupported database driver %q", cfg.DB.Driver)
	}
	defer closeDatabase()

	issuer, err := auth.NewTokenIssuer(cfg.Auth.JWTSecret, cfg.Auth.AccessTTL)
	if err != nil {
		return err
	}
	authSvc, err := service.NewAuthService(userRepo, tokenRepo, txManager, service.AuthServiceConfig{
		Issuer:     issuer,
		RefreshTTL: cfg.Auth.RefreshTTL,
		// M1-4 replaces this with the settings-backed snapshot.
		Site:         service.OpenSiteConfig(),
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

	authHandler := handler.NewAuthHandler(
		authSvc,
		handler.DefaultCookieConfig(cfg.IsProduction(), cfg.Auth.RefreshTTL),
		middleware.NewRateLimiter(5, time.Minute, 5),
	)

	router := httpapi.NewRouter(httpapi.Deps{
		Config: cfg, Logger: log, Ready: ready,
		Auth: authHandler, Sessions: authSvc,
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
