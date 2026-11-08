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
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
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

    // 品牌背景图与卷图标：都是「锦上添花」，缺一个就退回朴素窗口，不让出包失败。
    const icon = join(DESKTOP, 'resources', 'icon.png');
    const background1x = join(DESKTOP, 'resources', 'dmg-background.png');
    const background2x = join(DESKTOP, 'resources', 'dmg-background@2x.png');
    let backgroundFile;
    if (existsSync(background1x) && existsSync(background2x)) {
      // 1x + 2x 合成 HiDPI TIFF：Retina 屏上清晰，普通屏用 1x。tiffutil 是系统自带。
      mkdirSync(join(stage, '.background'), { recursive: true });
      backgroundFile = 'background.tiff';
      run('tiffutil', ['-cathidpicheck', background1x, background2x, '-out', join(stage, '.background', backgroundFile)]);
    } else if (existsSync(background1x)) {
      mkdirSync(join(stage, '.background'), { recursive: true });
      backgroundFile = 'background.png';
      cpSync(background1x, join(stage, '.background', backgroundFile));
    }
    const icns = existsSync(icon) ? makeIcns(icon, join(stage, '..', `wmind-${version}-${label}.icns`)) : undefined;

    const dmg = join(dir, `wmind-${version}-${label}.dmg`);
    const styled = backgroundFile !== undefined;

    try {
      // 要摆图标、设背景就得挂载读写盘，摆完再压成只读分发包。
      run('hdiutil', ['create', '-volname', `wmind ${version}`, '-srcfolder', stage, '-ov', '-format', 'UDRW', '-fs', 'HFS+', rwImage]);
      const mount = attachImage(rwImage);
      try {
        if (icns) {
          cpSync(icns, join(mount, '.VolumeIcon.icns'));
          if (hasCommand('SetFile')) run('SetFile', ['-a', 'C', mount]);
        }
        if (styled) arrangeDmgWindow(mount, `wmind ${version}`, backgroundFile);
      } finally {
        run('hdiutil', ['detach', mount, '-quiet']);
      }
      run('hdiutil', ['convert', rwImage, '-format', 'UDZO', '-o', dmg]);
    } catch (error) {
      console.warn(`警告：定制 dmg 外观失败（${error.message}），回退朴素窗口。`);
      run('hdiutil', ['create', '-volname', `wmind ${version}`, '-srcfolder', stage, '-ov', '-format', 'UDZO', '-fs', 'HFS+', dmg]);
    }
    return dmg;
  } finally {
    rmSync(stage, { recursive: true, force: true });
    rmSync(rwImage, { force: true });
    rmSync(join(stage, '..', `wmind-${version}-${label}.icns`), { force: true });
  }
}

/**
 * 用 Finder 摆好 DMG 窗口：窗口大小、隐藏工具栏、图标尺寸与位置、背景图。
 *
 * 图标坐标必须与 dmg-background.py 画的箭头对齐（窗口 660×400 pt，应用
 * (200,300)、Applications (460,300)）。背景图支持 1x+2x 合成的 HiDPI TIFF。
 * 这段要靠 Finder 自动化，无界面环境或权限被拒时会抛错，由调用方回退。
 */
function arrangeDmgWindow(mount, volume, backgroundFile) {
  const script = `tell application "Finder"
  tell disk "${volume}"
    open
    set current view of container window to icon view
    set toolbar visible of container window to false
    set statusbar visible of container window to false
    set the bounds of container window to {300, 200, 960, 600}
    set theViewOptions to the icon view options of container window
    set arrangement of theViewOptions to not arranged
    set icon size of theViewOptions to 128
    set background picture of theViewOptions to file ".background:${backgroundFile}"
    set position of item "wmind.app" of container window to {200, 300}
    set position of item "Applications" of container window to {460, 300}
    close
    open
    update without registering applications
    delay 2
  end tell
end tell`;
  run('osascript', ['-e', script]);
}

/**
 * 把 1024 的 PNG 转成 .icns。/**
 * 把 1024 的 PNG 转成 .icns。
 *
 * 用系统自带的 sips + iconutil 而不是引一个图像库：这两条命令在所有受支持的
 * macOS 上都在，而且不改变仓库依赖。
 */
/**
 * 把 mygo 产出的 Linux 应用目录打成 AppImage。
 *
 * AppImage 的承诺是「一个文件，下载即用」，但它**不能替用户装上系统库**：
 * 我们的窗口用系统 WebKitGTK 4.1 + GTK3（无 cgo、运行时 dlopen），所以 AppImage
 * 里不带这些库——在没装 libwebkit2gtk-4.1 的老发行版上依然会启动失败。把
 * WebKitGTK 整个塞进去会让包体涨到 200MB 以上，且要处理 LGPL 合规，暂时不做。
 * 因此 AppImage 的定位是「比 tarball 好用、比 .deb 通用」，不是「零依赖」。
 */
function packageAppImage(platform, version) {
  const arch = platform.split('/')[1];
  const appImageArch = arch === 'arm64' ? 'aarch64' : 'x86_64';
  const dir = join(OUT_DIR, `linux-${arch}`);
  const appDir = join(dir, 'wmind.AppDir');
  const slug = 'wmind';

  rmSync(appDir, { recursive: true, force: true });
  mkdirSync(join(appDir, 'usr', 'bin'), { recursive: true });
  mkdirSync(join(appDir, 'usr', 'share', 'applications'), { recursive: true });
  mkdirSync(join(appDir, 'usr', 'share', 'icons', 'hicolor', '256x256', 'apps'), { recursive: true });

  // 只拷应用本身（可执行 + resources），打包产物与安装脚本不进 AppDir。
  const skipped = new Set(['PKGBUILD', 'install.sh', 'install.ps1', 'SHA256SUMS', 'wmind.AppDir']);
  for (const name of readdirSync(dir)) {
    if (name.endsWith('.tar.gz') || name.endsWith('.deb') || name.endsWith('.zip') || name.endsWith('.AppImage')) continue;
    if (name.startsWith('update-') && name.endsWith('.json')) continue;
    if (skipped.has(name)) continue;
    const from = join(dir, name);
    if (name === slug) {
      cpSync(from, join(appDir, 'usr', 'bin', slug));
    } else if (name.endsWith('.png') || name.endsWith('.xml') || name.endsWith('.desktop')) {
      continue; // 图标与 desktop 文件由下面自己生成，避免和 mygo 的命名打架
    } else {
      cpSync(from, join(appDir, 'usr', 'bin', name), { recursive: true });
    }
  }

  const icon = join(DESKTOP, 'resources', 'icon.png');
  if (existsSync(icon)) {
    cpSync(icon, join(appDir, slug + '.png'));
    cpSync(icon, join(appDir, 'usr', 'share', 'icons', 'hicolor', '256x256', 'apps', slug + '.png'));
  }

  writeFileSync(join(appDir, 'AppRun'), `#!/bin/sh
HERE="$(dirname "$(readlink -f "$0")")"
exec "$HERE/usr/bin/${slug}" "$@"
`, { mode: 0o755 });

  writeFileSync(join(appDir, slug + '.desktop'), `[Desktop Entry]
Type=Application
Name=wmind
Comment=思维导图 / Mind map
Exec=${slug}
Icon=${slug}
Categories=Office;Graphics;
Terminal=false
StartupWMClass=wmind
`);

  // WMIND_APPIMAGE_DRYRUN=1：只生成 AppDir 不调 appimagetool，用来在非 Linux
  // 机器上检查目录结构与 AppRun 是否正确（CI 之外的快速自检）。
  if (process.env.WMIND_APPIMAGE_DRYRUN === '1') {
    console.log(`  （dry-run）AppDir: ${appDir}`);
    for (const entry of readdirSync(appDir)) console.log(`    ${entry}`);
    return;
  }

  const tool = appImageTool();
  if (!tool) {
    console.warn('警告：拿不到 appimagetool，跳过 AppImage（.deb 与 tarball 仍可用）。');
    return;
  }
  const out = join(dir, `${slug}-${version}-linux-${arch}.AppImage`);
  rmSync(out, { force: true });
  run(tool, [appDir, out], {
    env: { ...process.env, ARCH: appImageArch, APPIMAGE_EXTRACT_AND_RUN: '1' },
  });
  rmSync(appDir, { recursive: true, force: true });
  console.log(`  ${out}`);
}

/**
 * 下载并缓存 appimagetool（它自己是 AppImage，用 --appimage-extract-and-run 免 FUSE）。
 *
 * 取**宿主架构**的二进制：目标架构由 ARCH 环境变量告诉它（交叉打包的标准做法），
 * 所以 x86_64 的 CI 也能给 arm64 打 AppImage。
 */
function appImageTool() {
  const hostArch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  const cache = join(homedir(), '.cache', 'wmind');
  mkdirSync(cache, { recursive: true });
  const path = join(cache, `appimagetool-${hostArch}.AppImage`);
  if (existsSync(path)) return path;
  const url = `https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-${hostArch}.AppImage`;
  try {
    run('curl', ['-fsSL', '--max-time', '120', '-o', path, url]);
    execFileSync('chmod', ['+x', path]);
    return path;
  } catch (error) {
    console.warn(`警告：下载 appimagetool 失败（${error.message}）`);
    return undefined;
  }
}

/** 挂载磁盘映像并返回挂载点（卷名带空格，不能按列切分）。 */
function attachImage(image) {
  const out = execFileSync('hdiutil', ['attach', '-nobrowse', image], { encoding: 'utf8' });
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

/**
 * 更新包的签名私钥。
 *
 * 私钥绝不入库：优先取环境变量（CI 用），否则读本机 mygo 的默认密钥目录。
 * 拿不到就照常出包，只是不写更新清单——安装好的旧版本无法据此升级，这一点
 * 必须让发布的人看见，所以打一行提示。
 */
function updaterPrivateKey() {
  if (process.env.MYGO_UPDATER_PRIVATE_KEY) return process.env.MYGO_UPDATER_PRIVATE_KEY;
  const candidates = [
    join(homedir(), 'Library', 'Application Support', 'mygo', 'update-keys', 'mygo-update.key'),
    join(homedir(), '.config', 'mygo', 'update-keys', 'mygo-update.key'),
  ];
  for (const path of candidates) {
    if (existsSync(path)) return readFileSync(path, 'utf8').trim();
  }
  return undefined;
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

  const privateKey = updaterPrivateKey();
  if (!privateKey) {
    console.warn('警告：没有找到更新签名私钥，本次不生成更新清单（旧版本将无法自动升级）。');
    console.warn('      把 mygo keygen 生成的 mygo-update.key 放到 ~/Library/Application Support/mygo/update-keys/，');
    console.warn('      或在 CI 里设置 MYGO_UPDATER_PRIVATE_KEY。');
  }

  console.log('生成安装包…');
  run('go', args, {
    cwd: DESKTOP,
    env: {
      ...process.env,
      GOFLAGS: [process.env.GOFLAGS, '-tags=desktopfrontend'].filter(Boolean).join(' '),
      MYGO_LDFLAGS: [process.env.MYGO_LDFLAGS, ldflags].filter(Boolean).join(' '),
      ...(privateKey ? { MYGO_UPDATER_PRIVATE_KEY: privateKey } : {}),
    },
  });

  // Windows 用户更习惯 zip：mygo 只写 tar.gz（那是更新用的归档），这里再补一份
  // 同名 zip，方便没装 NSIS 安装包的场景下手工分发。
  for (const platform of platforms) {
    if (!platform.startsWith('windows/')) continue;
    const dir = join(OUT_DIR, platform.replace('/', '-'));
    const archive = readdirSync(dir).find((name) => name.endsWith('.tar.gz'));
    if (!archive) continue;
    const zipName = archive.replace(/\.tar\.gz$/, '.zip');
    const zip = join(dir, zipName);
    rmSync(zip, { force: true });
    // 打整个应用目录（exe + 资源 + .mygo-files），只排除归档、更新清单和 zip 自己。
    run('zip', ['-qry', zipName, '.', '-x', archive, '-x', 'update-*.json', '-x', zipName], { cwd: dir });
    console.log(`  ${zip}`);
  }

  // Linux：在 mygo 的产物（可执行 + .deb + tarball）之外再打一份 AppImage。
  // appimagetool 只有 Linux 版，所以这一步在 macOS 上跳过、由 CI 的 ubuntu 作业完成。
  for (const platform of platforms) {
    if (!platform.startsWith('linux/')) continue;
    if (process.platform !== 'linux' && process.env.WMIND_APPIMAGE_DRYRUN !== '1') {
      console.log(`  （跳过 AppImage：appimagetool 只能在 Linux 上运行，${platform} 的 AppImage 由 CI 产出）`);
      continue;
    }
    packageAppImage(platform, version);
  }

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
  let platforms = args.platforms.length > 0 ? args.platforms : [hostPlatform()];
  // 打安装包时的默认目标：macOS 与 Windows 都出 arm64 + amd64 两个包
  // （Apple Silicon / Intel 各自原生运行，universal 单包会让所有人多下载一倍）。
  // Linux 需要时用 --platform 显式给。
  if (args.package && args.platforms.length === 0) {
    platforms = ['darwin/arm64', 'darwin/amd64', 'windows/amd64', 'windows/arm64'];
  }

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
