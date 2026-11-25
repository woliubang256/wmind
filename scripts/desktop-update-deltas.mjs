import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseVersion } from './release.mjs';

function previousDesktopVersion(version, tags) {
  parseVersion(version);
  const compare = (left, right) => left.localeCompare(right, 'en', { numeric: true });
  return tags
    .filter(tag => /^desktop-v(?:0|[1-9]\d*)\.\d\.\d$/.test(tag))
    .map(tag => tag.slice('desktop-v'.length))
    .filter(candidate => compare(candidate, version) < 0)
    .sort(compare)
    .at(-1);
}

// mygo may use an older platform-specific base when the previous release
// lacks a manifest. The published feeds only advertise the previous release.
function retainPreviousDeltas(version, dir, tags) {
  const previous = previousDesktopVersion(version, tags);
  const files = readdirSync(dir, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile());
  const patches = files.filter(entry => entry.name.endsWith('.delta'));
  const retained = new Set();
  for (const entry of files) {
    const target = /^update-([a-z]+-[a-z0-9]+)\.json$/.exec(entry.name)?.[1];
    if (!target) continue;
    const path = join(entry.parentPath, entry.name);
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    if (manifest.version !== version) throw new Error(`${entry.name} 版本与桌面发布版本不一致`);
    const expected = `wmind-${previous}-to-${version}-${target}.delta`;
    const patch = previous && patches.find(file => file.name === expected && file.parentPath === entry.parentPath);
    const delta = patch && manifest.deltas?.find(candidate =>
      candidate.from === previous && candidate.url?.endsWith('/' + expected));
    if (delta) retained.add(join(patch.parentPath, patch.name));
    if (!('deltas' in manifest) && !('previous' in manifest)) continue;
    delete manifest.previous;
    delete manifest.deltas;
    if (delta) manifest.deltas = [delta];
    writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n');
  }
  for (const patch of patches) {
    const path = join(patch.parentPath, patch.name);
    if (!retained.has(path)) rmSync(path);
  }
}

const [, , version, artifacts] = process.argv;
const tags = readFileSync(0, 'utf8').trim().split(/\s+/);
retainPreviousDeltas(version, artifacts, tags);
