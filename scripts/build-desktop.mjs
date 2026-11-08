#!/usr/bin/env node
// 构建桌面客户端：前端产物 → 嵌入 → Go 二进制。
//
// 用法：
//   node scripts/build-desktop.mjs                       # 本机平台
//   node scripts/build-desktop.mjs --platform darwin/arm64,windows/amd64,linux/amd64
//   node scripts/build-desktop.mjs --skip-frontend       # 只重新编译 Go 侧
//   node scripts/build-desktop.mjs --package             # 额外产出安装包（.app/.dmg、NSIS、.deb）
//
// 版本号取自 VERSION（发布元数据的唯一来源），同时注入桌面入口与后端的
// config.Version，保证窗口里显示与 /site/config 返回的版本一致。

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readVersion } from './release.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DESKTOP = join(ROOT, 'backend', 'desktop');
const FRONTEND_DIST = join(ROOT, 'frontend', 'dist');
const EMBED_DIR = join(DESKTOP, 'frontend-dist');
const OUT_DIR = join(DESKTOP, 'build');

const DESKTOP_VERSION_SYMBOL = 'main.version';
const BACKEND_VERSION_SYMBOL = 'github.com/woliubang256/wmind/backend/internal/config.Version';

function parseArgs(argv) {
  const args = { platforms: [], skipFrontend: false, package: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--skip-frontend') args.skipFrontend = true;
    else if (arg === '--package') args.package = true;
    else if (arg === '--platform') {
      const value = argv[++i];
      if (!value) throw new Error('--platform 需要一个值，例如 darwin/arm64');
      args.platforms.push(...value.split(',').map((p) => p.trim()).filter(Boolean));
    } else if (arg.startsWith('--platform=')) {
      args.platforms.push(...arg.slice('--platform='.length).split(',').map((p) => p.trim()).filter(Boolean));
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  return args;
}

function hostPlatform() {
  const os = { darwin: 'darwin', linux: 'linux', win32: 'windows' }[process.platform];
  const arch = { x64: 'amd64', arm64: 'arm64' }[process.arch];
  if (!os || !arch) throw new Error(`不支持的宿主平台：${process.platform}/${process.arch}`);
  return `${os}/${arch}`;
}

function run(command, args, options = {}) {
  execFileSync(command, args, { stdio: 'inherit', cwd: ROOT, ...options });
}

// 前端产物必须存在且带 index.html：否则嵌进去的会是一个打不开的窗口。
function buildFrontend() {
  run('pnpm', ['--dir', 'frontend', 'build']);
  if (!existsSync(join(FRONTEND_DIST, 'index.html'))) {
    throw new Error('前端构建产物缺少 index.html，请检查 pnpm build');
  }
  rmSync(EMBED_DIR, { recursive: true, force: true });
  mkdirSync(EMBED_DIR, { recursive: true });
  cpSync(FRONTEND_DIST, EMBED_DIR, { recursive: true });
}

function buildFor(platform, version) {
  const [goos, goarch] = platform.split('/');
  if (!goos || !goarch) throw new Error(`平台格式应为 os/arch：${platform}`);
  const dir = join(OUT_DIR, `${goos}-${goarch}`);
  mkdirSync(dir, { recursive: true });
  const output = join(dir, goos === 'windows' ? 'wmind.exe' : 'wmind');
  if (goarch === 'universal') {
    buildUniversal(goos, dir, output, version);
    return output;
  }

  const ldflags = [
    `-X ${DESKTOP_VERSION_SYMBOL}=${version}`,
    `-X ${BACKEND_VERSION_SYMBOL}=${version}`,
  ].join(' ');

  run('go', ['build', '-trimpath', '-tags', 'desktopfrontend', '-ldflags', ldflags, '-o', output, '.'], {
    cwd: DESKTOP,
    env: {
      ...process.env,
      // 桌面端同样保持无 cgo：三端都能从任意机器交叉编译。
      CGO_ENABLED: '0',
      GOOS: goos,
      GOARCH: goarch,
    },
  });
  return output;
}

/**
 * darwin/universal：先分别编两个架构，再用 lipo 合成一个二进制。
 *
 * 单独写而不是指望 go build 支持 universal（它不支持）：一个包同时覆盖 Intel
 * 与 Apple Silicon，用户不用挑。
 */
function buildUniversal(goos, dir, output, version) {
  const ldflags = [
    `-X ${DESKTOP_VERSION_SYMBOL}=${version}`,
    `-X ${BACKEND_VERSION_SYMBOL}=${version}`,
  ].join(' ');
  const parts = ['arm64', 'amd64'].map((arch) => {
    const part = join(dir, `wmind-${arch}`);
    run('go', ['build', '-trimpath', '-tags', 'desktopfrontend', '-ldflags', ldflags, '-o', part, '.'], {
      cwd: DESKTOP,
      env: { ...process.env, CGO_ENABLED: '0', GOOS: goos, GOARCH: arch },
    });
    return part;
  });
  run('lipo', ['-create', '-output', output, ...parts]);
  for (const part of parts) rmSync(part, { force: true });
}

/**
 * 用 hdiutil 出 .dmg，而不是让 mygo 自己打包。
 *
 * mygo 的 dmg 步骤调用 `ditto --noclone`，这个选项在 macOS 13 及更早的 ditto
 * 上不存在（会直接报 unrecognized option），而这些版本仍在支持期内。hdiutil
 * 是同一份系统自带工具，行为在所有版本上都一样，还能顺便把「拖到 Applications」
 * 的软链接放进去。
 */
function createDmg(appPath, version, dir, label) {
  const stage = mkdtempSync(join(tmpdir(), 'wmind-dmg-'));
  const rwImage = join(stage, '..', `wmind-${version}-${label}-rw.dmg`);
  try {
    cpSync(appPath, join(stage, 'wmind.app'), { recursive: true, dereference: false });
    symlinkSync('/Applications', join(stage, 'Applications'));

    const dmg = join(dir, `wmind-${version}-${label}.dmg`);
    const plain = ['create', '-volname', `wmind ${version}`, '-srcfolder', stage, '-ov', '-format', 'UDZO', '-fs', 'HFS+', dmg];

    // 磁盘映像的图标只能在挂载后写进卷根（macOS 13 的 hdiutil 没有 -volicon）。
    // 拿不到 SetFile 或任何一步失败都退回「没有卷图标」的普通 dmg：图标是
    // 装饰，不该让出包失败。
    const icns = join(stage, '..', `wmind-${version}-${label}.icns`);
    let withIcon = false;
    if (existsSync(join(DESKTOP, 'resources', 'icon.png')) && hasCommand('SetFile')) {
      try {
        makeIcns(join(DESKTOP, 'resources', 'icon.png'), icns);
        withIcon = true;
      } catch {
        withIcon = false;
      }
    }
    if (!withIcon) {
      run('hdiutil', plain);
      return dmg;
    }

    try {
      run('hdiutil', ['create', '-volname', `wmind ${version}`, '-srcfolder', stage, '-ov', '-format', 'UDRW', '-fs', 'HFS+', rwImage]);
      const mount = attachImage(rwImage);
      try {
        cpSync(icns, join(mount, '.VolumeIcon.icns'));
        run('SetFile', ['-a', 'C', mount]);
      } finally {
        run('hdiutil', ['detach', mount, '-quiet']);
      }
      run('hdiutil', ['convert', rwImage, '-format', 'UDZO', '-o', dmg]);
    } catch {
      run('hdiutil', plain);
    }
    return dmg;
  } finally {
    rmSync(stage, { recursive: true, force: true });
    rmSync(rwImage, { force: true });
    rmSync(join(stage, '..', `wmind-${version}-${label}.icns`), { force: true });
  }
}

/** 挂载磁盘映像并返回挂载点（卷名带空格，不能按列切分）。 */
function attachImage(image) {
  const out = execFileSync('hdiutil', ['attach', '-nobrowse', '-readwrite', image], { encoding: 'utf8' });
  const match = out.split('\n').map((line) => line.trim()).find((line) => line.includes('/Volumes/'));
  if (!match) throw new Error('hdiutil attach did not report a mount point');
  return match.slice(match.indexOf('/Volumes/'));
}

function hasCommand(name) {
  try {
    execFileSync('which', [name], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * 把 1024 的 PNG 转成 .icns。
 *
 * 用系统自带的 sips + iconutil 而不是引一个图像库：这两条命令在所有受支持的
 * macOS 上都在，而且不改变仓库依赖。
 */
function makeIcns(pngPath, outPath) {
  const iconset = `${outPath}.iconset`;
  mkdirSync(iconset, { recursive: true });
  const sizes = [16, 32, 128, 256, 512];
  for (const size of sizes) {
    for (const scale of [1, 2]) {
      const pixels = size * scale;
      const name = `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`;
      run('sips', ['-z', String(pixels), String(pixels), pngPath, '--out', join(iconset, name)]);
    }
  }
  run('iconutil', ['-c', 'icns', iconset, '-o', outPath]);
  rmSync(iconset, { recursive: true, force: true });
  return outPath;
}

// packageApps 用 mygo 的 CLI 生成平台安装包（.app/.dmg、NSIS、.deb）。
//
// 前端嵌入靠 GOFLAGS 的构建标签，版本靠 MYGO_LDFLAGS——CLI 自己不接受
// 这两个参数，但会把它们透传给 go build。
function packageApps(platforms, version) {
  const ldflags = [
    `-X ${DESKTOP_VERSION_SYMBOL}=${version}`,
    `-X ${BACKEND_VERSION_SYMBOL}=${version}`,
  ].join(' ');
  const args = [
    'run',
    'github.com/egoist/mygo/cmd/mygo@v0.8.3',
    'build',
    '-platform',
    platforms.join(','),
  ];
  // 没有签名身份时不尝试公证：公证必须有 Developer ID。
  if (!process.env.MYGO_SIGN_IDENTITY) args.push('-skip-notarize');
  // .dmg 由本脚本用 hdiutil 出（见 createDmg）：mygo 的 ditto --noclone 在
  // macOS 13 上不可用。
  args.push('-skip-dmg');

  console.log('生成安装包…');
  run('go', args, {
    cwd: DESKTOP,
    env: {
      ...process.env,
      GOFLAGS: [process.env.GOFLAGS, '-tags=desktopfrontend'].filter(Boolean).join(' '),
      MYGO_LDFLAGS: [process.env.MYGO_LDFLAGS, ldflags].filter(Boolean).join(' '),
    },
  });

  if (process.platform !== 'darwin') return;
  for (const platform of platforms) {
    if (!platform.startsWith('darwin/')) continue;
    const arch = platform.split('/')[1];
    const dir = join(OUT_DIR, `darwin-${arch}`);
    const appPath = join(dir, 'wmind.app');
    if (!existsSync(appPath)) continue;
    const dmg = createDmg(appPath, version, dir, arch);
    console.log(`  ${dmg}`);
  }
}

/**
 * 校验 mygo.json 的版本与 VERSION 一致。
 *
 * 两处版本号各有用途：VERSION 是发布元数据的唯一来源（标签、镜像、changelog
 * 都认它），mygo.json 决定安装包与 .app 里写的版本。两者漂移的后果是「用户装
 * 的 1.0.1 报告自己是 1.0.0」，自动更新会一直认为该更新。这里让它构建时就红。
 */
function checkPackageVersion(version) {
  const path = join(DESKTOP, 'mygo.json');
  if (!existsSync(path)) return;
  const config = JSON.parse(readFileSync(path, 'utf8'));
  if (config.version !== version) {
    throw new Error(
      `backend/desktop/mygo.json 的 version（${config.version}）与 VERSION（${version}）不一致：请把 mygo.json 的 version 改成 ${version}`,
    );
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const version = readVersion(ROOT);
  checkPackageVersion(version);
  const platforms = args.platforms.length > 0 ? args.platforms : [hostPlatform()];

  if (!args.skipFrontend) buildFrontend();
  if (!existsSync(join(EMBED_DIR, 'index.html'))) {
    throw new Error('缺少 backend/desktop/frontend-dist/index.html：先构建前端，或去掉 --skip-frontend');
  }

  const outputs = platforms.map((platform) => buildFor(platform, version));
  console.log(`wmind 桌面版 ${version} 构建完成：`);
  for (const output of outputs) console.log(`  ${output}`);
  if (readdirSync(EMBED_DIR).length === 0) console.log('（提示：嵌入目录为空，窗口会显示占位页）');

  if (args.package) {
    packageApps(platforms, version);
  }
}

main();
