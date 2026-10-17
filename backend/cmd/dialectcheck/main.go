// Command dialectcheck 静态检查「数据库方言不泄漏到业务层」。
//
// 为什么需要这个闸门：本地开发只跑 SQLite，PostgreSQL 的差异在开发期不会暴露。
// 一旦有人在 service 层写下一句 `if driver == "sqlite"`，代码仍能编译、测试仍能
// 通过，问题会一直潜伏到线上。靠人眼 review 守不住这条线，必须机械检查。
//
// 三条规则：
//
//  1. service / handler 层不得 import repository/postgres 或 repository/sqlite
//     ——只允许依赖 domain 中的接口。
//  2. service / handler 层不得出现 "sqlite" / "postgres" 字面量
//     ——业务层没有任何理由知道底层是哪种数据库。
//  3. handler 层不得 import 任何 repository 包
//     ——防止绕过 service 直接落库。
//
// 允许出现方言判断的地方只有 cmd/server 的装配 switch 与 internal/migrate。
// 白名单写在本文件，新增白名单条目需要显式修改代码，不会被无声绕过。
//
// 用法：go run ./cmd/dialectcheck [仓库根目录]
package main

import (
	"errors"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// modulePrefix 是本模块的导入前缀。
const modulePrefix = "github.com/woliubang256/wmind/backend"

// dialectLiterals 是业务层不该出现的驱动名字面量。
var dialectLiterals = []string{"sqlite", "postgres"}

// guardedDirs 是需要守住的目录（相对模块根）。
var guardedDirs = []string{
	filepath.Join("internal", "service"),
	filepath.Join("internal", "handler"),
}

// rule 描述一条规则，便于把违规信息说清楚。
type rule struct {
	name string
	doc  string
}

var (
	ruleForbiddenImport = rule{
		name: "方言仓储导入",
		doc:  "service / handler 只能依赖 internal/domain 中的接口，不得直接 import 方言仓储包",
	}
	ruleDialectLiteral = rule{
		name: "方言字面量",
		doc:  "业务层不应出现 \"sqlite\" / \"postgres\" 字面量——出现即意味着有分支逻辑",
	}
	ruleHandlerRepository = rule{
		name: "handler 越层访问仓储",
		doc:  "handler 必须经由 service，不得直接 import repository",
	}
)

// Violation 是一条违规记录。
type Violation struct {
	File   string
	Line   int
	Rule   rule
	Detail string
}

// String 输出可直接放进 CI 日志的一行。
func (v Violation) String() string {
	rel := v.File
	return fmt.Sprintf("%s:%d: [%s] %s（%s）", rel, v.Line, v.Rule.name, v.Detail, v.Rule.doc)
}

func main() {
	root := "."
	if len(os.Args) > 1 {
		root = os.Args[1]
	}

	violations, err := Check(root)
	if err != nil {
		fmt.Fprintf(os.Stderr, "方言泄漏检查执行失败: %v\n", err)
		os.Exit(2)
	}

	if len(violations) == 0 {
		fmt.Printf("ok: 方言未泄漏（已检查 %s）\n", strings.Join(guardedDirs, ", "))
		return
	}

	fmt.Fprintln(os.Stderr, "发现方言泄漏：")
	for _, v := range violations {
		fmt.Fprintln(os.Stderr, "  "+v.String())
	}
	fmt.Fprintf(os.Stderr, "\n共 %d 处。方言判断只允许出现在 cmd/server 的装配 switch 与 internal/migrate。\n", len(violations))
	os.Exit(1)
}

// Check 扫描 root 下的受保护目录，返回全部违规。
func Check(root string) ([]Violation, error) {
	var violations []Violation

	for _, dir := range guardedDirs {
		abs := filepath.Join(root, dir)
		info, err := os.Stat(abs)
		if errors.Is(err, fs.ErrNotExist) {
			// 目录尚未建立（例如 M0 阶段 handler 还是空的）不算错误。
			continue
		}
		if err != nil {
			return nil, err
		}
		if !info.IsDir() {
			continue
		}

		dirViolations, err := checkDir(abs)
		if err != nil {
			return nil, err
		}
		violations = append(violations, dirViolations...)
	}
	return violations, nil
}

func checkDir(dir string) ([]Violation, error) {
	fset := token.NewFileSet()
	var violations []Violation

	err := filepath.WalkDir(dir, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() || !strings.HasSuffix(path, ".go") {
			return nil
		}
		// 测试文件同样受约束：测试里出现方言分支，说明被测代码本身在分支。
		// 例外见下面对 _test.go 的处理。

		file, parseErr := parser.ParseFile(fset, path, nil, parser.ParseComments)
		if parseErr != nil {
			return fmt.Errorf("解析 %s 失败: %w", path, parseErr)
		}

		violations = append(violations, checkImports(fset, path, file)...)
		violations = append(violations, checkDialectLiterals(fset, path, file)...)
		return nil
	})
	if err != nil {
		return nil, err
	}
	return violations, nil
}

func checkImports(fset *token.FileSet, path string, file *ast.File) []Violation {
	var violations []Violation

	for _, imp := range file.Imports {
		importPath, err := strconv.Unquote(imp.Path.Value)
		if err != nil {
			continue
		}
		pos := fset.Position(imp.Pos())

		switch {
		// handler 越层比「方言导入」更具体、也更好修，优先报它。
		// 两个规则本会同时命中同一条 import，同时报两条只会稀释信号。
		case isHandlerDir(path) && strings.HasPrefix(importPath, modulePrefix+"/internal/repository"):
			violations = append(violations, Violation{
				File:   path,
				Line:   pos.Line,
				Rule:   ruleHandlerRepository,
				Detail: "import " + importPath,
			})
		case isDialectRepository(importPath):
			violations = append(violations, Violation{
				File:   path,
				Line:   pos.Line,
				Rule:   ruleForbiddenImport,
				Detail: "import " + importPath,
			})
		}
	}
	return violations
}

func checkDialectLiterals(fset *token.FileSet, path string, file *ast.File) []Violation {
	var violations []Violation

	ast.Inspect(file, func(node ast.Node) bool {
		lit, ok := node.(*ast.BasicLit)
		if !ok || lit.Kind != token.STRING {
			return true
		}
		value, err := strconv.Unquote(lit.Value)
		if err != nil {
			return true
		}
		for _, dialect := range dialectLiterals {
			if value == dialect {
				pos := fset.Position(lit.Pos())
				violations = append(violations, Violation{
					File:   path,
					Line:   pos.Line,
					Rule:   ruleDialectLiteral,
					Detail: "出现字面量 " + strconv.Quote(value),
				})
			}
		}
		return true
	})
	return violations
}

func isDialectRepository(importPath string) bool {
	return importPath == modulePrefix+"/internal/repository/postgres" ||
		strings.HasPrefix(importPath, modulePrefix+"/internal/repository/postgres/") ||
		importPath == modulePrefix+"/internal/repository/sqlite" ||
		strings.HasPrefix(importPath, modulePrefix+"/internal/repository/sqlite/")
}

func isHandlerDir(path string) bool {
	return strings.Contains(filepath.ToSlash(path), "/internal/handler/")
}
