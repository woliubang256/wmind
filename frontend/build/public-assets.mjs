import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, posix, resolve, sep } from 'node:path';

const MODULE = 'virtual:wmind-public-assets';
const RESOLVED_MODULE = `\0${MODULE}`;
const hash = (source) => createHash('sha256').update(source).digest('hex').slice(0, 20);

/** Public source files keep stable names; only production copies become immutable. */
/** @returns {import('vite').Plugin} */
export function versionedPublicAssets() {
  let config;
  let urls = {};

  return {
    name: 'wmind-versioned-public-assets',
    configResolved(resolved) {
      config = resolved;
    },
    buildStart() {
      urls = {};
      if (config.command !== 'build') return;
      if (!config.publicDir) throw new Error('Public assets require a public directory');
      const sourceRoot = resolve(config.publicDir);
      const emitted = new Map();

      const read = (url) => {
        const filename = resolve(sourceRoot, `.${url}`);
        if (!filename.startsWith(sourceRoot + sep)) throw new Error(`Invalid public asset path: ${url}`);
        this.addWatchFile(filename);
        return readFileSync(filename);
      };
      const emit = (url, source) => {
        const extension = extname(url);
        const fileName = `assets${url.slice(0, -extension.length)}-${hash(source)}${extension}`;
        this.emitFile({ type: 'asset', fileName, source });
        return `${config.base}${fileName}`;
      };
      const fontDir = join(sourceRoot, 'fonts');
      for (const file of readdirSync(fontDir).filter((name) => name.endsWith('.css')).sort()) {
        const url = `/fonts/${file}`;
        const css = read(url).toString('utf8').replace(/url\(\s*(['"]?)(\/fonts\/[^'"\s)]+)\1\s*\)/g, (_match, _quote, shard) => {
          if (posix.extname(shard) !== '.woff2' || shard.includes('..')) throw new Error(`Invalid font shard: ${shard}`);
          let versioned = emitted.get(shard);
          if (!versioned) {
            versioned = emit(shard, read(shard));
            emitted.set(shard, versioned);
          }
          return `url('${versioned}')`;
        });
        urls[url] = emit(url, css);
      }
      urls['/wmind-logo.jpg'] = emit('/wmind-logo.jpg', read('/wmind-logo.jpg'));
    },
    resolveId(id) {
      if (id === MODULE) return RESOLVED_MODULE;
    },
    load(id) {
      if (id === RESOLVED_MODULE) {
        return `const urls = ${JSON.stringify(urls)}; export function publicAssetUrl(path) { return Object.hasOwn(urls, path) ? urls[path] : path; }`;
      }
    },
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        const logo = urls['/wmind-logo.jpg'];
        return logo ? html.replace(/(href\s*=\s*)(['"])\/wmind-logo\.jpg\2/g, `$1"${logo}"`) : html;
      },
    },
  };
}
