/**
 * Small in-memory token-bucket rate limiter keyed by client IP + route.
 *
 * Per-process only (good enough for the single-instance demo deployment); it
 * protects AI-backed endpoints, outing creation, voting and merchant login
 * from bursts. Not a substitute for an edge rate limiter in production.
 *
 * The client IP honours TRUSTED_PROXY_HOPS (see `clientIp`): forwarding
 * headers are only believed as far as the configured proxies vouch for them.
 */
import { config } from "./env";
import { ServiceError } from "./http";

export interface RateLimitRule {
  /** Bucket size (burst). */
  capacity: number;
  /** Tokens added per minute. */
  refillPerMinute: number;
}

export const RATE_LIMITS = {
  createOuting: { capacity: 5, refillPerMinute: 5 },
  ai: { capacity: 10, refillPerMinute: 10 },
  vote: { capacity: 20, refillPerMinute: 30 },
  mutation: { capacity: 60, refillPerMinute: 60 },
  merchantLogin: { capacity: 5, refillPerMinute: 5 },
  judgeLogin: { capacity: 10, refillPerMinute: 10 },
  /** Wrong judge credentials: 5 in a row, then one more guess a minute. */
  judgeLoginFailure: { capacity: 5, refillPerMinute: 1 },
  invite: { capacity: 30, refillPerMinute: 30 },
  demo: { capacity: 10, refillPerMinute: 10 },
} satisfies Record<string, RateLimitRule>;

interface Bucket {
  tokens: number;
  updatedAt: number;
}

const MAX_KEYS = 10_000;

declare global {
  var __outingsRateLimits: Map<string, Bucket> | undefined;
}

function buckets(): Map<string, Bucket> {
  if (!globalThis.__outingsRateLimits) globalThis.__outingsRateLimits = new Map();
  return globalThis.__outingsRateLimits;
}

/** Shared key used when no trustworthy client address is available. */
export const UNKNOWN_CLIENT = "unknown";

/**
 * Client IP for rate-limit keys, given N = TRUSTED_PROXY_HOPS (the number of
 * reverse proxies in front of the app that append to X-Forwarded-For).
 *
 * Each trusted proxy appends the address it received the connection from, so
 * the N-th X-Forwarded-For entry counted from the RIGHT is the address the
 * outermost trusted proxy saw: the real client. Entries further left were
 * supplied by the client and are never used (they are trivially spoofable).
 *
 * - N = 0 (default): no proxy is trusted, so no forwarding header is trusted
 *   (neither X-Forwarded-For nor X-Real-IP); every caller shares the
 *   `"unknown"` key per route.
 * - N > 0: the N-th entry from the right; if the header is missing or has
 *   fewer than N entries, X-Real-IP (set by the trusted proxy); else
 *   `"unknown"`.
 */
export function clientIp(req: Request, trustedHops: number = config().trustedProxyHops): string {
  if (!Number.isInteger(trustedHops) || trustedHops <= 0) return UNKNOWN_CLIENT;
  const hops = (req.headers.get("x-forwarded-for") ?? "").split(",").map((h) => h.trim());
  const fromRight = hops.length >= trustedHops ? hops[hops.length - trustedHops] : undefined;
  if (fromRight) return fromRight.slice(0, 64);
  const real = req.headers.get("x-real-ip")?.trim();
  return real ? real.slice(0, 64) : UNKNOWN_CLIENT;
}

/** Consume one token; returns false when the bucket is empty. */
export function takeToken(key: string, rule: RateLimitRule, nowMs: number = Date.now()): boolean {
  const map = buckets();
  let b = map.get(key);
  if (!b) {
    if (map.size >= MAX_KEYS) {
      // Evict the oldest ~10% (Map preserves insertion order).
      let n = Math.ceil(MAX_KEYS / 10);
      for (const k of map.keys()) {
        map.delete(k);
        if (--n <= 0) break;
      }
    }
    b = { tokens: rule.capacity, updatedAt: nowMs };
    map.set(key, b);
  }
  const elapsedMin = Math.max(0, nowMs - b.updatedAt) / 60_000;
  b.tokens = Math.min(rule.capacity, b.tokens + elapsedMin * rule.refillPerMinute);
  b.updatedAt = nowMs;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

/** Throws 429 RATE_LIMITED when the caller exceeded the rule for this route. */
export function rateLimit(req: Request, route: string, rule: RateLimitRule, nowMs: number = Date.now()): void {
  if (!takeToken(`${clientIp(req)}|${route}`, rule, nowMs)) {
    throw new ServiceError("RATE_LIMITED", 429, "Too many requests. Please wait a moment and try again.");
  }
}

/**
 * Gives back a token taken with `takeToken`, for buckets that should only be charged on failure
 * (wrong sign-in credentials). Reserve with `takeToken` BEFORE any await and refund on success: a check
 * followed by a later charge would let a burst of concurrent requests all pass the check.
 */
export function refundToken(key: string, rule: RateLimitRule): void {
  const b = buckets().get(key);
  if (b) b.tokens = Math.min(rule.capacity, b.tokens + 1);
}

/** Test helper. */
export function resetRateLimits(): void {
  buckets().clear();
}
