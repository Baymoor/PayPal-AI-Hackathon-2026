/**
 * Small in-memory token-bucket rate limiter keyed by client IP + route.
 *
 * Per-process only (good enough for the single-instance demo deployment); it
 * protects AI-backed endpoints, outing creation, voting and merchant login
 * from bursts. Not a substitute for an edge rate limiter in production.
 */
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

/** Client IP: first X-Forwarded-For hop (set by the hosting proxy), then X-Real-IP. */
export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first.slice(0, 64);
  }
  const real = req.headers.get("x-real-ip")?.trim();
  return real ? real.slice(0, 64) : "local";
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

/** Test helper. */
export function resetRateLimits(): void {
  buckets().clear();
}
