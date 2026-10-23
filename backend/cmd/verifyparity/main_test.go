package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// ── 第 1 级：版本序列 ────────────────────────────────────────────────────────

// 这正是验收标准里那个负例：只在 postgres 侧加一个版本，闸门必须报错。
func TestDetectsVersionOnlyOnOneSide(t *testing.T) {
	root := t.TempDir()
	writeMigration(t, root, "postgres", "0001_init.up.sql", "SELECT 1;")
	writeMigration(t, root, "postgres", "0001_init.down.sql", "SELECT 1;")
	writeMigration(t, root, "sqlite", "0001_init.up.sql", "SELECT 1;")
	writeMigration(t, root, "sqlite", "0001_init.down.sql", "SELECT 1;")

	// 只在 postgres 侧追加 0002
	writeMigration(t, root, "postgres", "0002_add_foo.up.sql", "SELECT 1;")
	writeMigration(t, root, "postgres", "0002_add_foo.down.sql", "SELECT 1;")

	problems, err := checkMigrationFiles(root)
	if err != nil {
		t.Fatalf("检查执行失败: %v", err)
	}
	if !hasProblemContaining(problems, "版本 0002") {
		t.Fatalf("应报出只在单侧存在的版本，实际: %v", problems)
	}
}

func TestDetectsMissingDownFile(t *testing.T) {
	root := t.TempDir()
	writeMigration(t, root, "postgres", "0001_init.up.sql", "SELECT 1;")
	writeMigration(t, root, "sqlite", "0001_init.up.sql", "SELECT 1;")
	writeMigration(t, root, "sqlite", "0001_init.down.sql", "SELECT 1;")
	// postgres 侧故意不写 down

	problems, err := checkMigrationFiles(root)
	if err != nil {
		t.Fatalf("检查执行失败: %v", err)
	}
	if !hasProblemContaining(problems, "postgres 侧缺少 .down.sql") {
		t.Fatalf("应报出缺失的 down 文件，实际: %v", problems)
	}
}

func TestMatchingMigrationSetsPass(t *testing.T) {
	root := t.TempDir()
	for _, dir := range []string{"postgres", "sqlite"} {
		writeMigration(t, root, dir, "0001_init.up.sql", "SELECT 1;")
		writeMigration(t, root, dir, "0001_init.down.sql", "SELECT 1;")
	}

	problems, err := checkMigrationFiles(root)
	if err != nil {
		t.Fatalf("检查执行失败: %v", err)
	}
	if len(problems) != 0 {
		t.Fatalf("两侧一致时不应报错，实际: %v", problems)
	}
}

// 命名不合规要当场失败：静默忽略一个名字写错的迁移文件，
// 比报错危险得多——它不会被任何一侧执行，却看起来「已经改了」。
func TestRejectsMisnamedMigrationFile(t *testing.T) {
	root := t.TempDir()
	writeMigration(t, root, "postgres", "0001_init.up.sql", "SELECT 1;")
	writeMigration(t, root, "sqlite", "init.sql", "SELECT 1;")

	if _, err := checkMigrationFiles(root); err == nil {
		t.Fatal("命名不合规的迁移文件应当报错")
	}
}

// ── 第 2 级：结构比对 ────────────────────────────────────────────────────────

func TestCompareSchemasDetectsMissingColumn(t *testing.T) {
	pg := &schema{
		Columns: map[string][]column{"users": {{"id", "bigint"}, {"email", "text"}}},
		Indexes: map[string]index{},
	}
	lite := &schema{
		Columns: map[string][]column{"users": {{"id", "INTEGER"}}},
		Indexes: map[string]index{},
	}

	problems := compareSchemas(pg, lite)
	if !hasProblemContaining(problems, "列 email 在 sqlite 侧缺失") {
		t.Fatalf("应报出缺失的列，实际: %v", problems)
	}
}

// 类型映射是单向的：postgres 为规范版本，sqlite 必须落在映射表规定的类型上。
func TestCompareSchemasEnforcesTypeMapping(t *testing.T) {
	cases := []struct {
		name     string
		pgType   string
		liteType string
		wantErr  bool
	}{
		{"时间列必须存 TEXT", "timestamp with time zone", "TEXT", false},
		{"时间列写成 INTEGER 应报错", "timestamp with time zone", "INTEGER", true},
		{"JSON 存 TEXT", "jsonb", "TEXT", false},
		{"布尔存 INTEGER", "boolean", "INTEGER", false},
		{"布尔写成 BOOLEAN 应报错", "boolean", "BOOLEAN", true},
		{"BIGINT 存 INTEGER", "bigint", "INTEGER", false},
		{"INET 存 TEXT", "inet", "TEXT", false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			pg := &schema{
				Columns: map[string][]column{"t": {{"c", tc.pgType}}},
				Indexes: map[string]index{},
			}
			lite := &schema{
				Columns: map[string][]column{"t": {{"c", tc.liteType}}},
				Indexes: map[string]index{},
			}

			problems := compareSchemas(pg, lite)
			if tc.wantErr && len(problems) == 0 {
				t.Fatalf("期望报错（pg=%s, sqlite=%s），实际通过", tc.pgType, tc.liteType)
			}
			if !tc.wantErr && len(problems) != 0 {
				t.Fatalf("不应报错（pg=%s, sqlite=%s），实际: %v", tc.pgType, tc.liteType, problems)
			}
		})
	}
}

// 未登记的类型必须报错而不是静默放过：新加列用了没映射过的类型时，
// 闸门如果默认通过，就等于在最需要它的时刻失效。
func TestCompareSchemasRejectsUnmappedType(t *testing.T) {
	pg := &schema{
		Columns: map[string][]column{"t": {{"c", "uuid"}}},
		Indexes: map[string]index{},
	}
	lite := &schema{
		Columns: map[string][]column{"t": {{"c", "TEXT"}}},
		Indexes: map[string]index{},
	}

	problems := compareSchemas(pg, lite)
	if !hasProblemContaining(problems, "未登记的类型") {
		t.Fatalf("应报出未登记的类型，实际: %v", problems)
	}
}

// 白名单里的索引允许只在 postgres 侧存在；白名单外的缺失必须报错。
func TestCompareSchemasHonoursPostgresOnlyIndexAllowlist(t *testing.T) {
	pg := &schema{
		Columns: map[string][]column{"maps": {{"id", "bigint"}}},
		Indexes: map[string]index{
			"idx_maps_title_trgm": {Name: "idx_maps_title_trgm", Unique: false},
			"idx_maps_owner":      {Name: "idx_maps_owner", Unique: false},
		},
	}
	lite := &schema{
		Columns: map[string][]column{"maps": {{"id", "INTEGER"}}},
		Indexes: map[string]index{},
	}

	problems := compareSchemas(pg, lite)

	if hasProblemContaining(problems, "idx_maps_title_trgm") {
		t.Fatalf("白名单索引不应报错，实际: %v", problems)
	}
	if !hasProblemContaining(problems, "索引 idx_maps_owner 在 sqlite 侧缺失") {
		t.Fatalf("白名单外的索引缺失应报错，实际: %v", problems)
	}
}

func TestCompareSchemasDetectsIndexUniquenessMismatch(t *testing.T) {
	pg := &schema{
		Columns: map[string][]column{"t": {{"id", "bigint"}}},
		Indexes: map[string]index{"idx_a": {Name: "idx_a", Unique: true}},
	}
	lite := &schema{
		Columns: map[string][]column{"t": {{"id", "INTEGER"}}},
		Indexes: map[string]index{"idx_a": {Name: "idx_a", Unique: false}},
	}

	problems := compareSchemas(pg, lite)
	if !hasProblemContaining(problems, "唯一性不一致") {
		t.Fatalf("应报出索引唯一性不一致，实际: %v", problems)
	}
}

func TestCompareSchemasDetectsExtraTableOnSQLiteSide(t *testing.T) {
	pg := &schema{Columns: map[string][]column{"users": {{"id", "bigint"}}}, Indexes: map[string]index{}}
	lite := &schema{
		Columns: map[string][]column{
			"users": {{"id", "INTEGER"}},
			"stray": {{"id", "INTEGER"}},
		},
		Indexes: map[string]index{},
	}

	problems := compareSchemas(pg, lite)
	if !hasProblemContaining(problems, "表 stray 只存在于 sqlite") {
		t.Fatalf("应报出多余的表，实际: %v", problems)
	}
}

// ── 真实迁移集的自检 ────────────────────────────────────────────────────────

// Run in a subprocess: the regression held the only database connection until
// introspectPostgres's two-minute deadline, so a goroutine timeout would leave
// a blocked query alive in the test process. The child also tests a second run
// where the migrations return ErrNoChange.
func TestPostgresIntrospectionReleasesMigrationConnection(t *testing.T) {
	if os.Getenv("WMIND_TEST_DATABASE_URL") == "" {
		t.Skip("WMIND_TEST_DATABASE_URL not set")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestPostgresIntrospectionSubprocess$", "-test.v")
	cmd.Env = append(os.Environ(), "WMIND_PARITY_INTROSPECTION_CHILD=1")
	output, err := cmd.CombinedOutput()
	if ctx.Err() != nil {
		t.Fatalf("PostgreSQL introspection still waits for the migration connection: %v\n%s", ctx.Err(), output)
	}
	if err != nil {
		t.Fatalf("PostgreSQL introspection child failed: %v\n%s", err, output)
	}
	t.Logf("%s", output)
}

func TestPostgresIntrospectionSubprocess(t *testing.T) {
	if os.Getenv("WMIND_PARITY_INTROSPECTION_CHILD") != "1" {
		t.Skip("only runs as the isolated introspection regression subprocess")
	}
	lite, err := introspectSQLite()
	if err != nil {
		t.Fatal(err)
	}
	for attempt := 1; attempt <= 2; attempt++ {
		pg, err := introspectPostgres(os.Getenv("WMIND_TEST_DATABASE_URL"))
		if err != nil {
			t.Fatalf("introspection attempt %d: %v", attempt, err)
		}
		if problems := compareSchemas(pg, lite); len(problems) != 0 {
			t.Fatalf("real migrated schemas differ: %v", problems)
		}
		for dialect, got := range map[string]*schema{"postgres": pg, "sqlite": lite} {
			if _, ok := got.Indexes["idx_maps_trash_retention"]; !ok {
				t.Fatalf("%s did not apply migration 0004's retention index", dialect)
			}
		}
	}
}

// 直接对仓库里真正的 SQLite 迁移集跑一遍：既验证 DDL 可执行，
// 也把完整业务表集合钉住，防止后续误删表。
func TestRealSQLiteMigrationProducesExpectedTables(t *testing.T) {
	got, err := introspectSQLite()
	if err != nil {
		t.Fatalf("introspect SQLite 失败: %v", err)
	}

	want := []string{
		"audit_logs", "files", "map_revisions", "maps", "refresh_tokens",
		"settings", "share_links", "templates", "themes", "user_devices",
		"user_tokens", "user_two_factor", "users",
	}

	if len(got.Columns) != len(want) {
		t.Fatalf("期望 %d 张表，实际 %d 张: %v", len(want), len(got.Columns), sortedKeys(got.Columns))
	}
	for _, table := range want {
		if _, ok := got.Columns[table]; !ok {
			t.Errorf("表 %s 缺失", table)
		}
	}

	// 抽查关键列：这几列是双方言语义差异的落点，写错类型不会有编译错误。
	users := columnNames(got.Columns["users"])
	for _, name := range []string{"uid", "email", "password_hash", "role", "status", "map_count", "deleted_at"} {
		if !contains(users, name) {
			t.Errorf("users 表缺少列 %s（实际: %v）", name, users)
		}
	}

	maps := columnNames(got.Columns["maps"])
	for _, name := range []string{"uid", "owner_id", "document", "version", "deleted_at"} {
		if !contains(maps, name) {
			t.Errorf("maps 表缺少列 %s（实际: %v）", name, maps)
		}
	}
	for _, name := range []string{"user_id", "state", "revision"} {
		if !contains(columnNames(got.Columns["user_two_factor"]), name) {
			t.Errorf("user_two_factor 表缺少列 %s", name)
		}
	}

	// pg_trgm 索引是 PostgreSQL 专有的，SQLite 侧不该出现。
	if _, ok := got.Indexes["idx_maps_title_trgm"]; ok {
		t.Error("idx_maps_title_trgm 不应存在于 SQLite 侧")
	}
	// 但白名单外的显式索引必须在。
	for _, name := range []string{"idx_maps_owner_updated", "idx_maps_owner_deleted", "idx_share_owner", "idx_audit_created"} {
		if _, ok := got.Indexes[name]; !ok {
			t.Errorf("索引 %s 缺失", name)
		}
	}
}

// ── 辅助 ────────────────────────────────────────────────────────────────────

func writeMigration(t *testing.T, root, dialect, name, content string) {
	t.Helper()

	dir := filepath.Join(root, "db", "migrations", dialect)
	if err := os.MkdirAll(dir, 0o750); err != nil {
		t.Fatalf("创建目录失败: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o600); err != nil {
		t.Fatalf("写入迁移文件失败: %v", err)
	}
}

func hasProblemContaining(problems []problem, substr string) bool {
	for _, p := range problems {
		if strings.Contains(p.message, substr) {
			return true
		}
	}
	return false
}

func columnNames(cols []column) []string {
	names := make([]string, 0, len(cols))
	for _, c := range cols {
		names = append(names, c.Name)
	}
	return names
}

func contains(list []string, want string) bool {
	for _, v := range list {
		if v == want {
			return true
		}
	}
	return false
}
