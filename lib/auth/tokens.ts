import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** 256-bit url-safe invitation token. Shown once; only its hash is stored. */
export function generateInviteToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Deterministic tokens for DEMO fixture outings only, so the demo page can
 * re-derive persona links without storing plaintext tokens.
 */
export function demoInviteToken(secret: string, participantKey: string): string {
  return createHmac("sha256", secret).update(`demo-invite:${participantKey}`).digest("base64url");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
