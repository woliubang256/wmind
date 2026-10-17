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

	"github.com/woliubang256/wmind/backend/internal/config"
	"github.com/woliubang256/wmind/backend/internal/httpapi"
	"github.com/woliubang256/wmind/backend/internal/migrate"
	"github.com/woliubang256/wmind/backend/internal/pkg/logger"
	postgresrepo "github.com/woliubang256/wmind/backend/internal/repository/postgres"
	sqliterepo "github.com/woliubang256/wmind/backend/internal/repository/sqlite"
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

	default:
		return fmt.Errorf("unsupported database driver %q", cfg.DB.Driver)
	}
	defer closeDatabase()

	handler := httpapi.NewRouter(httpapi.Deps{Config: cfg, Logger: log, Ready: ready})
	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           handler,
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
