// Command verifyparity 校验两套迁移集是否保持一致。
//
// 它拦的是最容易发生、也最难发现的错误——**只改了一边的迁移**。本地开发只跑
// SQLite，PostgreSQL 侧的漂移在开发期完全不可见，等到生产切库才炸。
//
// 分两级，各自独立可跑：
//
//	第 1 级（永远执行，纯文件系统）
//	  两套迁移集的版本号序列一致；每个版本在两侧都有 .up.sql 与 .down.sql。
//	  「只在一侧加了一个迁移」当场就被抓住。
//
//	第 2 级（需要真实数据库）
//	  各起一个库、跑一遍迁移、introspect 出「表 → 列（名 + 类型）→ 显式索引」
//	  再比对。PostgreSQL 侧需要 WMIND_TEST_DATABASE_URL；未设置时跳过并明确
//	  说明，CI 里必须设置，否则这道闸门形同虚设。
//
// 类型比对是**单向**的：PostgreSQL 为规范版本，SQLite 必须落在映射表规定的
// 类型上（docs/03 §3.2.1）。反向比对做不到——SQLite 用 TEXT 存时间、JSON 和
// 普通字符串，光看声明类型无法区分，所以不能让 SQLite 当基准。
//
// 用法：go run ./cmd/verifyparity [模块根目录]
package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/golang-migrate/migrate/v4"
	"github.com/golang-migrate/migrate/v4/database"
	pgxmigrate "github.com/golang-migrate/migrate/v4/database/pgx/v5"
	sqlitemigrate "github.com/golang-migrate/migrate/v4/database/sqlite"
	"github.com/golang-migrate/migrate/v4/source"
	"github.com/golang-migrate/migrate/v4/source/iofs"
	_ "github.com/jackc/pgx/v5/stdlib"

	"github.com/woliubang256/wmind/backend/db/migrations"
	"github.com/woliubang256/wmind/backend/internal/repository/sqlite"
)

// migrationFile 匹配 golang-migrate 的文件命名：0001_init.up.sql
var migrationFile = regexp.MustCompile(`^(\d+)_([^.]+)\.(up|down)\.sql$`)

// migrationsTable 是 golang-migrate 的记账表，不属于业务 schema。
const migrationsTable = "schema_migrations"

// postgresOnlyIndexes 是**有意**只在 PostgreSQL 侧存在的索引。
//
// 白名单必须显式写在代码里而不是靠模糊匹配：任何新增条目都要改这个文件，
// 从而在 code review 里被看见。目前只有一条——pg_trgm 的 GIN 索引，
// 对应 docs/04 §7.9.3 方言落点清单的第 3 项。
var postgresOnlyIndexes = map[string]string{
	"idx_maps_title_trgm": "pg_trgm 专有，SQLite 侧标题搜索退化为 LIKE 全表扫描",
}

// pgToSQLiteType 是类型映射表（docs/03 §3.2.1）。
//
// 键是 information_schema 报出的 data_type，值是 SQLite 侧声明的类型。
var pgToSQLiteType = map[string]string{
	"bigint":                      "INTEGER",
	"integer":                     "INTEGER",
	"smallint":                    "INTEGER",
	"text":                        "TEXT",
	"character varying":           "TEXT",
	"jsonb":                       "TEXT",
	"json":                        "TEXT",
	"boolean":                     "INTEGER",
	"inet":                        "TEXT",
	"timestamp with time zone":    "TEXT",
	"timestamp without time zone": "TEXT",
}

// column 是规范化后的列。
type column struct {
	Name string
	Type string
}

// index 是规范化后的索引。
type index struct {
	Name   string
	Unique bool
}

// schema 是一个数据库的规范化结构快照。
type schema struct {
	// Columns 按「表名 → 列」组织，保持迁移文件里的列顺序。
	Columns map[string][]column
	// Indexes 是显式创建的索引（排除主键与 UNIQUE 约束自动生成的）。
	Indexes map[string]index
}

type problem struct {
	message string
}

func main() {
	root := "."
	if len(os.Args) > 1 {
		root = os.Args[1]
	}

	var problems []problem

	// ── 第 1 级：文件层面 ──────────────────────────────
	fileProblems, err := checkMigrationFiles(root)
	if err != nil {
		fmt.Fprintf(os.Stderr, "检查迁移文件失败: %v\n", err)
		os.Exit(2)
	}
	problems = append(problems, fileProblems...)

	// ── 第 2 级：结构层面 ──────────────────────────────
	structProblems, err := checkStructure(root)
	if err != nil {
		fmt.Fprintf(os.Stderr, "结构比对失败: %v\n", err)
		os.Exit(2)
	}
	problems = append(problems, structProblems...)

	if len(problems) == 0 {
		fmt.Println("ok: 两套迁移集一致")
		return
	}

	fmt.Fprintln(os.Stderr, "迁移集不一致：")
	for _, p := range problems {
		fmt.Fprintln(os.Stderr, "  - "+p.message)
	}
	fmt.Fprintf(os.Stderr, "\n共 %d 处。schema 变更必须同时改 migrations/postgres 与 migrations/sqlite。\n", len(problems))
	os.Exit(1)
}

// ── 第 1 级 ──────────────────────────────────────────────────────────────────

// migrationSets 记录一套迁移集里每个版本的可用方向。
type migrationSets map[int]map[string]bool

func checkMigrationFiles(root string) ([]problem, error) {
	pg, err := readMigrationSet(filepath.Join(root, "db", "migrations", "postgres"))
	if err != nil {
		return nil, err
	}
	lite, err := readMigrationSet(filepath.Join(root, "db", "migrations", "sqlite"))
	if err != nil {
		return nil, err
	}

	var problems []problem

	for _, version := range unionVersions(pg, lite) {
		pgDirs, inPG := pg[version]
		liteDirs, inLite := lite[version]

		if !inPG {
			problems = append(problems, problem{fmt.Sprintf(
				"版本 %04d 只存在于 sqlite，postgres 侧缺失", version)})
			continue
		}
		if !inLite {
			problems = append(problems, problem{fmt.Sprintf(
				"版本 %04d 只存在于 postgres，sqlite 侧缺失", version)})
			continue
		}

		for _, direction := range []string{"up", "down"} {
			if !pgDirs[direction] {
				problems = append(problems, problem{fmt.Sprintf(
					"版本 %04d 的 postgres 侧缺少 .%s.sql", version, direction)})
			}
			if !liteDirs[direction] {
				problems = append(problems, problem{fmt.Sprintf(
					"版本 %04d 的 sqlite 侧缺少 .%s.sql", version, direction)})
			}
		}
	}
	return problems, nil
}

func readMigrationSet(dir string) (migrationSets, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, fmt.Errorf("读取 %s 失败: %w", dir, err)
	}

	set := make(migrationSets)
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		matches := migrationFile.FindStringSubmatch(entry.Name())
		if matches == nil {
			return nil, fmt.Errorf("%s/%s 不符合 {版本}_{名称}.{up|down}.sql 命名", dir, entry.Name())
		}
		version, err := strconv.Atoi(matches[1])
		if err != nil {
			return nil, fmt.Errorf("解析 %s 的版本号失败: %w", entry.Name(), err)
		}
		if set[version] == nil {
			set[version] = make(map[string]bool)
		}
		set[version][matches[3]] = true
	}
	return set, nil
}

func unionVersions(sets ...migrationSets) []int {
	seen := make(map[int]bool)
	for _, set := range sets {
		for version := range set {
			seen[version] = true
		}
	}
	versions := make([]int, 0, len(seen))
	for version := range seen {
		versions = append(versions, version)
	}
	sort.Ints(versions)
	return versions
}

// ── 第 2 级 ──────────────────────────────────────────────────────────────────

func checkStructure(root string) ([]problem, error) {
	liteSchema, err := introspectSQLite()
	if err != nil {
		return nil, fmt.Errorf("introspect SQLite 失败: %w", err)
	}

	pgURL := strings.TrimSpace(os.Getenv("WMIND_TEST_DATABASE_URL"))
	if pgURL == "" {
		fmt.Fprintln(os.Stderr, "注意: 未设置 WMIND_TEST_DATABASE_URL，已跳过 PostgreSQL 结构比对。")
		fmt.Fprintln(os.Stderr, "      本地没有 PostgreSQL 时这是预期行为；CI 必须设置该变量，否则这道闸门不生效。")
		return nil, nil
	}

	pgSchema, err := introspectPostgres(pgURL)
	if err != nil {
		return nil, fmt.Errorf("introspect PostgreSQL 失败: %w", err)
	}

	return compareSchemas(pgSchema, liteSchema), nil
}

func compareSchemas(pg, lite *schema) []problem {
	var problems []problem

	// 表集合
	for _, table := range sortedKeys(pg.Columns) {
		if _, ok := lite.Columns[table]; !ok {
			problems = append(problems, problem{fmt.Sprintf("表 %s 在 sqlite 侧缺失", table)})
		}
	}
	for _, table := range sortedKeys(lite.Columns) {
		if _, ok := pg.Columns[table]; !ok {
			problems = append(problems, problem{fmt.Sprintf("表 %s 只存在于 sqlite，postgres 侧缺失", table)})
		}
	}

	// 列名与类型（单向：postgres 为规范版本）
	for _, table := range sortedKeys(pg.Columns) {
		liteCols, ok := lite.Columns[table]
		if !ok {
			continue
		}
		pgCols := pg.Columns[table]

		liteByName := make(map[string]column, len(liteCols))
		for _, c := range liteCols {
			liteByName[c.Name] = c
		}
		pgByName := make(map[string]column, len(pgCols))
		for _, c := range pgCols {
			pgByName[c.Name] = c
		}

		for _, c := range pgCols {
			liteCol, ok := liteByName[c.Name]
			if !ok {
				problems = append(problems, problem{fmt.Sprintf(
					"表 %s 的列 %s 在 sqlite 侧缺失", table, c.Name)})
				continue
			}
			want, known := pgToSQLiteType[strings.ToLower(c.Type)]
			if !known {
				problems = append(problems, problem{fmt.Sprintf(
					"表 %s 的列 %s 使用了未登记的类型 %q，请先在 pgToSQLiteType 中补充映射",
					table, c.Name, c.Type)})
				continue
			}
			if !strings.EqualFold(liteCol.Type, want) {
				problems = append(problems, problem{fmt.Sprintf(
					"表 %s 的列 %s 类型不符：postgres 为 %s，sqlite 应为 %s，实际 %s",
					table, c.Name, c.Type, want, liteCol.Type)})
			}
		}
		for _, c := range liteCols {
			if _, ok := pgByName[c.Name]; !ok {
				problems = append(problems, problem{fmt.Sprintf(
					"表 %s 的列 %s 只存在于 sqlite", table, c.Name)})
			}
		}
	}

	// 显式索引
	for name, pgIndex := range pg.Indexes {
		if _, allowed := postgresOnlyIndexes[name]; allowed {
			continue
		}
		liteIndex, ok := lite.Indexes[name]
		if !ok {
			problems = append(problems, problem{fmt.Sprintf(
				"索引 %s 在 sqlite 侧缺失", name)})
			continue
		}
		if liteIndex.Unique != pgIndex.Unique {
			problems = append(problems, problem{fmt.Sprintf(
				"索引 %s 的唯一性不一致：postgres=%t，sqlite=%t", name, pgIndex.Unique, liteIndex.Unique)})
		}
	}
	for name := range lite.Indexes {
		if _, ok := pg.Indexes[name]; !ok {
			problems = append(problems, problem{fmt.Sprintf(
				"索引 %s 只存在于 sqlite", name)})
		}
	}

	return problems
}

func introspectSQLite() (*schema, error) {
	dir, err := os.MkdirTemp("", "wmind-parity-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(dir)

	path := filepath.Join(dir, "parity.db")
	migrationDB, err := sqlite.Open(path)
	if err != nil {
		return nil, err
	}
	if err := runMigrations(migrationDB, "sqlite"); err != nil {
		return nil, err
	}
	db, err := sqlite.Open(path)
	if err != nil {
		return nil, err
	}
	defer db.Close()

	out := &schema{Columns: map[string][]column{}, Indexes: map[string]index{}}

	rows, err := db.Query(`SELECT name FROM sqlite_master
		WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> ?`, migrationsTable)
	if err != nil {
		return nil, err
	}
	var tables []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			rows.Close()
			return nil, err
		}
		tables = append(tables, name)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	for _, table := range tables {
		// PRAGMA table_info 按 cid 返回，即迁移文件里的列顺序。
		colRows, err := db.Query(fmt.Sprintf("PRAGMA table_info(%s)", quoteIdent(table)))
		if err != nil {
			return nil, err
		}
		for colRows.Next() {
			var (
				cid       int
				name      string
				ctype     string
				notNull   int
				dfltValue sql.NullString
				pk        int
			)
			if err := colRows.Scan(&cid, &name, &ctype, &notNull, &dfltValue, &pk); err != nil {
				colRows.Close()
				return nil, err
			}
			out.Columns[table] = append(out.Columns[table], column{Name: name, Type: ctype})
		}
		colRows.Close()

		idxRows, err := db.Query(fmt.Sprintf("PRAGMA index_list(%s)", quoteIdent(table)))
		if err != nil {
			return nil, err
		}
		for idxRows.Next() {
			var (
				seq     int
				name    string
				unique  int
				origin  string
				partial int
			)
			if err := idxRows.Scan(&seq, &name, &unique, &origin, &partial); err != nil {
				idxRows.Close()
				return nil, err
			}
			// sqlite_autoindex_* 是 PRIMARY KEY / UNIQUE 约束自动生成的，
			// PostgreSQL 侧对应的是约束索引（同样被排除），两边都不算显式索引。
			if strings.HasPrefix(name, "sqlite_autoindex_") {
				continue
			}
			out.Indexes[name] = index{Name: name, Unique: unique == 1}
		}
		idxRows.Close()
	}

	return out, nil
}

func introspectPostgres(url string) (*schema, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	migrationDB, err := sql.Open("pgx", url)
	if err != nil {
		return nil, err
	}
	migrationDB.SetMaxOpenConns(1)
	if err := runMigrations(migrationDB, "postgres"); err != nil {
		return nil, err
	}
	db, err := sql.Open("pgx", url)
	if err != nil {
		return nil, err
	}
	defer db.Close()
	db.SetMaxOpenConns(1)

	out := &schema{Columns: map[string][]column{}, Indexes: map[string]index{}}

	// 列：按 ordinal_position 排序，与迁移文件里的书写顺序一致。
	rows, err := db.QueryContext(ctx, `
		SELECT table_name, column_name, data_type
		FROM information_schema.columns
		WHERE table_schema = current_schema()
		  AND table_name <> $1
		ORDER BY table_name, ordinal_position`, migrationsTable)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var table, name, dataType string
		if err := rows.Scan(&table, &name, &dataType); err != nil {
			rows.Close()
			return nil, err
		}
		out.Columns[table] = append(out.Columns[table], column{Name: name, Type: dataType})
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// 显式索引：排除主键与 UNIQUE 约束自动创建的索引，与 SQLite 侧口径一致。
	idxRows, err := db.QueryContext(ctx, `
		SELECT i.relname, ix.indisunique
		FROM pg_index ix
		JOIN pg_class i ON i.oid = ix.indexrelid
		JOIN pg_class t ON t.oid = ix.indrelid
		JOIN pg_namespace n ON n.oid = t.relnamespace
		WHERE n.nspname = current_schema()
		  AND t.relname <> $1
		  AND ix.indexrelid NOT IN (
		      SELECT conindid FROM pg_constraint WHERE conindid <> 0
		  )`, migrationsTable)
	if err != nil {
		return nil, err
	}
	defer idxRows.Close()
	for idxRows.Next() {
		var name string
		var unique bool
		if err := idxRows.Scan(&name, &unique); err != nil {
			return nil, err
		}
		out.Indexes[name] = index{Name: name, Unique: unique}
	}
	return out, idxRows.Err()
}

// ── 共用 ─────────────────────────────────────────────────────────────────────

// runMigrations 拥有迁移专用 db，返回前关闭；内省必须另开连接。
func runMigrations(db *sql.DB, driver string) (err error) {
	var (
		src      source.Driver
		dbDriver database.Driver
		m        *migrate.Migrate
	)
	defer func() { err = errors.Join(err, db.Close()) }()
	defer func() {
		if m != nil {
			sourceErr, databaseErr := m.Close()
			err = errors.Join(err, sourceErr, databaseErr)
			return
		}
		// 初始化中途失败也释放已经成功创建的资源。
		if dbDriver != nil {
			err = errors.Join(err, dbDriver.Close())
		}
		if src != nil {
			err = errors.Join(err, src.Close())
		}
	}()

	switch driver {
	case "sqlite":
		if src, err = iofs.New(migrations.SQLiteFS, "sqlite"); err != nil {
			return err
		}
		if dbDriver, err = sqlitemigrate.WithInstance(db, &sqlitemigrate.Config{}); err != nil {
			return err
		}
	case "postgres":
		if src, err = iofs.New(migrations.PostgresFS, "postgres"); err != nil {
			return err
		}
		if dbDriver, err = pgxmigrate.WithInstance(db, &pgxmigrate.Config{}); err != nil {
			return err
		}
	default:
		return fmt.Errorf("未知驱动 %q", driver)
	}

	m, err = migrate.NewWithInstance("iofs", src, driver, dbDriver)
	if err != nil {
		return err
	}

	// pgx 迁移驱动为会话锁固定持有 *sql.Conn，必须连同迁移器关闭，
	// 不能留给内省复用单连接池，否则后续查询永远拿不到连接。
	if err := m.Up(); err != nil && !errors.Is(err, migrate.ErrNoChange) {
		return err
	}
	return nil
}

// quoteIdent 为 SQLite 的 PRAGMA 参数加双引号。
func quoteIdent(name string) string {
	return `"` + strings.ReplaceAll(name, `"`, `""`) + `"`
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
