// Limits of the hosted server: token buckets (requests a minute per key, invalid keys per client address) and the
// client address behind our own proxy. Memory is bounded: the least recently seen entries go first.
const MS_PER_MINUTE = 60_000;
const MS_PER_SECOND = 1_000;
const DEFAULT_MAX_TRACKED = 50_000;
const MAX_IP_LENGTH = 45; // longest IPv6 text form
const IPV6_GROUPS = 8;
const IPV6_PREFIX_GROUPS = 4; // a /64: one host usually owns all of it

const PRIVATE_IP = /^(?:127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|169\.254\.|::1$|f[cd][0-9a-f]{2}:|fe80:)/i;
const IP_TEXT = /^[0-9a-f:.]+$/i;

/** Loopback, private and link-local addresses: our own proxy (Caddy in the Docker network) and internal callers. */
export const isInternalIp = (ip) => PRIVATE_IP.test(ip);

const plainIp = (s) => String(s ?? '').trim().replace(/^::ffff:/i, '');

/**
 * Client address: the last X-Forwarded-For hop when the peer is our own proxy (a private address — Caddy overwrites
 * what clients send), else the peer itself.
 * @param {import('node:http').IncomingMessage} req
 * @returns {string}
 */
export function clientIp(req) {
  const peer = plainIp(req.socket?.remoteAddress);
  const xff = req.headers['x-forwarded-for'];
  if (!xff || !isInternalIp(peer)) return peer;
  const last = plainIp(String(xff).split(',').pop());
  return last.length <= MAX_IP_LENGTH && IP_TEXT.test(last) ? last : peer;
}

/** Counting bucket of an address: IPv4 as is, IPv6 per /64. */
export function bucketOf(ip) {
  if (!ip.includes(':')) return ip;
  const [head, tail = ''] = ip.toLowerCase().split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...h, ...Array(Math.max(0, IPV6_GROUPS - h.length - t.length)).fill('0'), ...t] : h;
  return `${groups.slice(0, IPV6_PREFIX_GROUPS).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

/** Map insertion order is age: the entry moves to the newest end, the oldest goes past max. */
export function remember(map, key, value, max) {
  map.delete(key);
  map.set(key, value);
  if (map.size > max) map.delete(map.keys().next().value);
}

/**
 * Token bucket per id: `perMinute` a minute on average, bursts up to `burst`. perMinute <= 0 switches it off.
 * @param {{perMinute: number, burst?: number, maxTracked?: number, now?: () => number}} options
 */
export function createRateLimiter({ perMinute, burst = perMinute, maxTracked = DEFAULT_MAX_TRACKED, now = Date.now }) {
  const enabled = perMinute > 0;
  const perMs = perMinute / MS_PER_MINUTE;
  const buckets = new Map(); // id -> {tokens, at}
  const level = (id, t) => {
    const b = buckets.get(id);
    return b ? Math.min(burst, b.tokens + (t - b.at) * perMs) : burst;
  };
  const waitSeconds = (tokens) => Math.max(1, Math.ceil((1 - tokens) / perMs / MS_PER_SECOND));
  return {
    enabled,
    /** Seconds until the id may go on; 0 — it may now. Takes nothing. */
    blockedFor(id) {
      if (!enabled) return 0;
      const tokens = level(id, now());
      return tokens >= 1 ? 0 : waitSeconds(tokens);
    },
    /** Take one token: 0 — taken, else seconds to wait (nothing taken). */
    take(id) {
      if (!enabled) return 0;
      const t = now();
      const tokens = level(id, t);
      if (tokens < 1) return waitSeconds(tokens);
      remember(buckets, id, { tokens: tokens - 1, at: t }, maxTracked);
      return 0;
    },
    tracked: () => buckets.size,
  };
}
