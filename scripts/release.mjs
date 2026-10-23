import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VERSION_RE = /^(0|[1-9]\d*)\.([0-9])\.([0-9])$/;
const PACKAGE_FILES = ['package.json', 'frontend/package.json'];
const VERSION_SYMBOL = 'github.com/woliubang256/wmind/backend/internal/config.Version';

export function parseVersion(value) {
  const match = VERSION_RE.exec(value);
  if (!match) throw new Error(`版本必须为 x.y.z，y/z 为 0–9：${value}`);
  return { major: BigInt(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export function nextVersion(value) {
  let { major, minor, patch } = parseVersion(value);
  if (++patch === 10) { patch = 0; minor++; }
  if (minor === 10) { minor = 0; major++; }
  return `${major}.${minor}.${patch}`;
}

export function readVersion(root = ROOT) {
  const value = readFileSync(join(root, 'VERSION'), 'utf8').trim();
  parseVersion(value);
  for (const file of PACKAGE_FILES) {
    if (JSON.parse(readFileSync(join(root, file), 'utf8')).version !== value) {
      throw new Error(`${file} 版本与 VERSION 不一致`);
    }
  }
  return value;
}

export function checkTag(tag, root = ROOT) {
  if (typeof tag !== 'string' || !tag.startsWith('v')) throw new Error('发布标签必须为 vX.Y.Z');
  parseVersion(tag.slice(1));
  if (tag !== `v${readVersion(root)}`) throw new Error(`标签 ${tag} 与 VERSION 不一致`);
  return tag;
}

export function bumpVersion(root = ROOT) {
  const version = nextVersion(readVersion(root));
  // Read and validate all sources before changing any of them.
  const packages = PACKAGE_FILES.map(file => [file, JSON.parse(readFileSync(join(root, file), 'utf8'))]);
  for (const [file, data] of packages) {
    data.version = version;
    writeFileSync(join(root, file), `${JSON.stringify(data, null, 2)}\n`);
  }
  writeFileSync(join(root, 'VERSION'), `${version}\n`);
  return version;
}

function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function versionIndex(version) {
  const { major, minor, patch } = parseVersion(version);
  return major * 100n + BigInt(minor * 10 + patch);
}

const GROUPS = [
  ['feat', '新增功能'], ['fix', '问题修复'], ['perf', '性能改进'], ['refactor', '代码优化'],
  ['build', '构建与发布'], ['ci', '持续集成'], ['doc', '文档'], ['test', '测试'], ['chore', '维护'], ['other', '其他变更'],
];

export function changelog(tag, root = ROOT) {
  checkTag(tag, root);
  const tags = git(root, 'tag', '--list').split('\n');
  const target = tags.includes(tag) ? `refs/tags/${tag}` : 'HEAD';
  const candidates = git(root, 'tag', '--merged', target, '--list', 'v*').split('\n')
    .filter(value => value.startsWith('v') && VERSION_RE.test(value.slice(1)) && versionIndex(value.slice(1)) < versionIndex(tag.slice(1)))
    .sort((a, b) => versionIndex(a.slice(1)) > versionIndex(b.slice(1)) ? -1 : 1);
  const previous = candidates[0];
  const range = previous ? `${previous}..${target}` : target;
  const groups = new Map(GROUPS.map(([key]) => [key, []]));
  for (const line of git(root, 'log', '--reverse', '--format=%h%x09%s', range).split('\n').filter(Boolean)) {
    const separator = line.indexOf('\t');
    const hash = line.slice(0, separator);
    const subject = line.slice(separator + 1);
    const match = /^(\w+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/.exec(subject);
    let type = match?.[1];
    if (type === 'docs') type = 'doc';
    const items = groups.get(type) ?? groups.get('other');
    const description = match ? `${match[3] ? '**不兼容变更** ' : ''}${match[2] ? `${match[2]}：` : ''}${match[4]}` : subject;
    items.push(`- ${description} (\`${hash}\`)`);
  }
  const lines = [`# ${tag}`, '', previous ? `自 ${previous} 以来的更新。` : '首次正式发布，包含以下历史变更。', ''];
  for (const [key, title] of GROUPS) {
    if (groups.get(key).length) lines.push(`## ${title}`, '', ...groups.get(key), '');
  }
  if (previous) lines.push(`[完整变更](https://github.com/woliubang256/wmind/compare/${previous}...${tag})`, '');
  return `${lines.join('\n')}\n`;
}

function copyRegular(source, destination) {
  const info = lstatSync(source);
  if (info.isSymbolicLink()) throw new Error(`发布文件不能是符号链接：${source}`);
  if (info.isDirectory()) {
    mkdirSync(destination, { recursive: true });
    for (const name of readdirSync(source)) copyRegular(join(source, name), join(destination, name));
  } else if (info.isFile()) {
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination);
  } else {
    throw new Error(`不支持的发布文件：${source}`);
  }
}

export function stagePackage(root, destination, tag, binary, notes) {
  checkTag(tag, root);
  const files = [
    ['VERSION', 'VERSION'], ['LICENSE', 'LICENSE'], ['backend/.env.example', 'backend/.env.example'],
    ['frontend/dist', 'frontend/dist'], ['deploy/nginx.conf', 'deploy/nginx.conf'],
    ['deploy/scripts/backup.sh', 'deploy/scripts/backup.sh'], ['deploy/scripts/restore.sh', 'deploy/scripts/restore.sh'],
  ];
  for (const [source, target] of files) copyRegular(join(root, source), join(destination, target));
  copyRegular(binary, join(destination, 'backend/wmind-server'));
  copyRegular(notes, join(destination, 'CHANGELOG.md'));
  // Deployment archives pull published images; they contain no application source to build.
  for (const file of ['docker-compose.yml', 'docker-compose.postgres.yml']) {
    const source = readFileSync(join(root, 'deploy', file), 'utf8');
    const compose = source.replace(/^    build:\n(?:^      .*\n)+/gm, '')
      .replaceAll('${WMIND_VERSION:-latest}', `\${WMIND_VERSION:-${tag}}`);
    if (/^\s+build:/m.test(compose)) throw new Error(`未能移除 ${file} 的源码构建配置`);
    writeFileSync(join(destination, 'deploy', file), compose);
  }
  writeFileSync(join(destination, 'deploy/.env.example'), readFileSync(join(root, 'deploy/.env.example'), 'utf8')
    .replace(/^WMIND_VERSION=.*$/m, `WMIND_VERSION=${tag}`));
  writeFileSync(join(destination, 'RELEASE.md'), `# wmind ${tag}\n\n` +
    `本包包含 Linux 服务二进制、静态前端和 Docker 部署配置。迁移已嵌入二进制，无需另行安装。\n\n` +
    `## Docker 部署\n\n在 deploy/ 中将 .env.example 复制为 .env，设置随机 JWT 密钥和管理员密码，然后执行：\n\n` +
    '```sh\ndocker compose pull\ndocker compose up -d\n```\n\n' +
    `PostgreSQL 使用 docker compose -f docker-compose.postgres.yml。默认固定 ${tag}；私有 GHCR 镜像需先 docker login ghcr.io。\n\n` +
    `## 二进制部署\n\n在 backend/ 中将 .env.example 复制为 .env，设置 WMIND_ENV=production、JWT 密钥和管理员密码，然后运行 ./wmind-server。\n\n` +
    `将 frontend/dist 交由静态文件服务器托管，SPA 回退到 index.html，/api/ 和 /uploads/ 代理到服务的 8080 端口。deploy/nginx.conf 是容器网络示例，独立部署需修改 root 和 api 上游地址。\n\n` +
    `访问 /api/v1/health/ready 检查就绪；/api/v1/site/config 的 version 应为 ${tag}。升级前备份数据库、上传文件和稳定的加密密钥。\n`);
}

export function packageRelease(tag, output, root = ROOT) {
  checkTag(tag, root);
  if (!existsSync(join(root, 'frontend/dist/index.html'))) throw new Error('请先构建 frontend/dist');
  const out = resolve(output);
  const notes = join(out, 'CHANGELOG.md');
  if (!existsSync(notes)) throw new Error('请先生成输出目录下的 CHANGELOG.md');
  mkdirSync(out, { recursive: true });
  const temp = mkdtempSync(join(tmpdir(), 'wmind-release-'));
  const checksums = [];
  try {
    for (const arch of ['amd64', 'arm64']) {
      const name = `wmind-${tag}-linux-${arch}`;
      const binary = join(temp, `wmind-${arch}`);
      execFileSync('go', ['build', '-trimpath', '-ldflags', `-s -w -X ${VERSION_SYMBOL}=${tag}`, '-o', binary, './cmd/server'], {
        cwd: join(root, 'backend'), env: { ...process.env, CGO_ENABLED: '0', GOOS: 'linux', GOARCH: arch }, stdio: 'inherit',
      });
      stagePackage(root, join(temp, name), tag, binary, notes);
      const archive = `${name}.tar.gz`;
      execFileSync('tar', ['-czf', join(out, archive), '-C', temp, name], { stdio: 'inherit' });
      checksums.push(`${createHash('sha256').update(readFileSync(join(out, archive))).digest('hex')}  ${archive}`);
    }
    checksums.push(`${createHash('sha256').update(readFileSync(notes)).digest('hex')}  CHANGELOG.md`);
    writeFileSync(join(out, 'SHA256SUMS'), `${checksums.join('\n')}\n`);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function main(args) {
  const [command, value, output] = args;
  switch (command) {
    case 'version': console.log(`v${readVersion()}`); break;
    case 'check': console.log(checkTag(value)); break;
    case 'bump': console.log(`v${bumpVersion()}`); break;
    case 'changelog': {
      if (!output) throw new Error('用法：release.mjs changelog <vX.Y.Z> <输出文件>');
      const content = changelog(value);
      mkdirSync(dirname(resolve(output)), { recursive: true });
      writeFileSync(output, content);
      break;
    }
    case 'package':
      if (!output) throw new Error('用法：release.mjs package <vX.Y.Z> <输出目录>');
      packageRelease(value, output);
      break;
    default: throw new Error('用法：release.mjs version | check <tag> | bump | changelog <tag> <文件> | package <tag> <目录>');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
