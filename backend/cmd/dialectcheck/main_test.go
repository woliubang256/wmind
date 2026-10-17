package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// writeFixture 在 root 下写入一个 Go 文件。
func writeFixture(t *testing.T, root, relPath, content string) {
	t.Helper()

	abs := filepath.Join(root, relPath)
	if err := os.MkdirAll(filepath.Dir(abs), 0o750); err != nil {
		t.Fatalf("创建目录失败: %v", err)
	}
	if err := os.WriteFile(abs, []byte(content), 0o600); err != nil {
		t.Fatalf("写入 fixture 失败: %v", err)
	}
}

const cleanService = `package service

import (
	"context"

	"github.com/woliubang256/wmind/backend/internal/domain"
)

type UserService struct {
	users domain.UserRepo
}

func (s *UserService) Get(ctx context.Context, uid string) (*domain.User, error) {
	return s.users.GetByUID(ctx, uid)
}
`

// 规则 1：service 不得 import 方言仓储。
func TestDetectsDialectRepositoryImportInService(t *testing.T) {
	root := t.TempDir()
	writeFixture(t, root, "internal/service/user.go", `package service

import (
	"github.com/woliubang256/wmind/backend/internal/repository/sqlite"
)

var _ = sqlite.Open
`)

	violations, err := Check(root)
	if err != nil {
		t.Fatalf("检查执行失败: %v", err)
	}
	assertViolation(t, violations, ruleForbiddenImport)
}

// 生成的子包同样要拦：import repository/postgres/pgdb 与 import
// repository/postgres 在泄漏性上没有区别。
func TestDetectsDialectRepositorySubpackageImport(t *testing.T) {
	root := t.TempDir()
	writeFixture(t, root, "internal/service/map.go", `package service

import (
	"github.com/woliubang256/wmind/backend/internal/repository/postgres/pgdb"
)

var _ = pgdb.New
`)

	violations, err := Check(root)
	if err != nil {
		t.Fatalf("检查执行失败: %v", err)
	}
	assertViolation(t, violations, ruleForbiddenImport)
}

// 规则 2：业务层出现驱动名字面量即视为有分支逻辑。
//
// 这条正是验收标准里那个负例——在 service 层写 `if driver == "sqlite"`。
func TestDetectsDialectLiteralInService(t *testing.T) {
	root := t.TempDir()
	writeFixture(t, root, "internal/service/export.go", `package service

func (s *Service) Export(driver string) string {
	if driver == "sqlite" {
		return "a"
	}
	return "b"
}
`)

	violations, err := Check(root)
	if err != nil {
		t.Fatalf("检查执行失败: %v", err)
	}
	assertViolation(t, violations, ruleDialectLiteral)
}

// 规则 3：handler 不得绕过 service 直接访问仓储。
func TestDetectsRepositoryImportInHandler(t *testing.T) {
	root := t.TempDir()
	writeFixture(t, root, "internal/handler/map.go", `package handler

import (
	"github.com/woliubang256/wmind/backend/internal/repository/postgres"
)

var _ = postgres.Connect
`)

	violations, err := Check(root)
	if err != nil {
		t.Fatalf("检查执行失败: %v", err)
	}
	assertViolation(t, violations, ruleHandlerRepository)
}

func TestCleanServiceHasNoViolations(t *testing.T) {
	root := t.TempDir()
	writeFixture(t, root, "internal/service/user.go", cleanService)

	violations, err := Check(root)
	if err != nil {
		t.Fatalf("检查执行失败: %v", err)
	}
	if len(violations) != 0 {
		t.Fatalf("合规代码不应报违规，实际 %d 处: %v", len(violations), violations)
	}
}

// 目录不存在（M0 阶段 handler 还是空的）不应视为失败，否则闸门会在项目早期
// 就红着，久而久之被忽略。
func TestMissingGuardedDirIsNotAnError(t *testing.T) {
	root := t.TempDir()

	violations, err := Check(root)
	if err != nil {
		t.Fatalf("目录缺失不应报错: %v", err)
	}
	if len(violations) != 0 {
		t.Fatalf("目录缺失不应产生违规，实际 %d 处", len(violations))
	}
}

// 白名单边界：domain 与 pkg 里的字面量不该被误伤——否则真话会被迫改成
// 拼接字符串来绕开检查，闸门就退化成噪音。
func TestDoesNotFlagOutsideGuardedDirs(t *testing.T) {
	root := t.TempDir()
	writeFixture(t, root, "internal/repository/sqlite/db.go", `package sqlite

const driver = "sqlite"

var _ = driver
`)
	writeFixture(t, root, "cmd/server/main.go", `package main

func driver() string { return "postgres" }

var _ = driver
`)

	violations, err := Check(root)
	if err != nil {
		t.Fatalf("检查执行失败: %v", err)
	}
	if len(violations) != 0 {
		t.Fatalf("受保护目录之外不应报违规，实际 %d 处: %v", len(violations), violations)
	}
}

func assertViolation(t *testing.T, violations []Violation, want rule) {
	t.Helper()

	if len(violations) == 0 {
		t.Fatalf("期望命中规则 %q，实际没有任何违规", want.name)
	}
	for _, v := range violations {
		if v.Rule == want {
			return
		}
	}
	var got []string
	for _, v := range violations {
		got = append(got, string(v.Rule.name))
	}
	t.Fatalf("期望命中规则 %q，实际命中 %s", want.name, strings.Join(got, ", "))
}
