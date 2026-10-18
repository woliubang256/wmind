/**
 * ID 生成。
 *
 * 用 ULID 而不是 `crypto.randomUUID()`：ULID 前缀是 48 位毫秒时间戳，
 * 按字典序排序等价于按创建时间排序。导图的兄弟节点顺序、审计日志、以及
 * 将来做增量同步时都会用到这个性质，而 UUID v4 完全随机、排不出时间序。
 *
 * 编码是 Crockford base32（去掉了 I L O U，避免手抄歧义），共 26 字符。
 * 后端 `internal/auth` 里的 ULID 生成与之同构。
 */

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_LEN = 10;
const RANDOM_LEN = 16;

function encodeTime(now: number): string {
  let time = Math.floor(now);
  let out = '';
  for (let i = TIME_LEN - 1; i >= 0; i -= 1) {
    out = CROCKFORD[time % 32] + out;
    time = Math.floor(time / 32);
  }
  return out;
}

function encodeRandom(): string {
  const bytes = new Uint8Array(RANDOM_LEN);
  const webCrypto = typeof crypto === 'undefined' ? undefined : crypto;
  if (webCrypto && typeof webCrypto.getRandomValues === 'function') {
    webCrypto.getRandomValues(bytes);
  } else {
    // 非浏览器环境（Node 单测、SSR 兜底）没有 Web Crypto 时退到 Math.random。
    // 只影响 ID 的随机性，不承担任何安全语义，可以接受。
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  let out = '';
  for (let i = 0; i < RANDOM_LEN; i += 1) {
    out += CROCKFORD[(bytes[i] ?? 0) % 32];
  }
  return out;
}

/**
 * 生成一个 ULID。
 *
 * 同一毫秒内连续调用不会保证单调递增（需要维护 lastTime/lastRandom 状态），
 * 这里刻意不做：文档内的兄弟顺序由数组下标决定，不依赖 ID 排序；
 * 加状态反而会让测试变得依赖调用时序。
 */
export function ulid(now: number = Date.now()): string {
  return encodeTime(now) + encodeRandom();
}

/** 主题 ID：`tp-<ulid>`。前缀让日志和 DOM 属性一眼可读。 */
export function newTopicId(): string {
  return `tp-${ulid()}`;
}

export function newSheetId(): string {
  return `sh-${ulid()}`;
}

export function newRelationshipId(): string {
  return `rel-${ulid()}`;
}

export function newBoundaryId(): string {
  return `bnd-${ulid()}`;
}

export function newSummaryId(): string {
  return `sum-${ulid()}`;
}

export function newDocumentId(): string {
  return ulid();
}
