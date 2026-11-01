import { secondsUntil } from "./rate-limit-policy.js";

/** Authenticated MCP calls per bearer token, per minute. */
export const DEFAULT_RATE_LIMIT_PER_MINUTE = 60;
/** Authenticated MCP calls for the whole Worker, per minute. */
export const DEFAULT_RATE_LIMIT_GLOBAL_PER_MINUTE = 600;
/**
 * Outbound Wise GETs. Wise documents HTTP 429 and Retry-After, not a fixed
 * quota. 5/second stays well under a burst that would trip that limiter.
 */
export const DEFAULT_WISE_PER_SECOND = 5;

export const MINUTE_MS = 60_000;
export const SECOND_MS = 1_000;

const MAX_PER_MINUTE = 10_000;
const MAX_PER_SECOND = 30;
const MAX_BACKOFF_MS = 120_000;
const MIN_BACKOFF_MS = 1_000;

export const QUOTA_INSTANCE = "quotas";

const BUCKET_KEY = /^(mcp:[0-9a-f]{64}|mcp:global|wise:api)$/;

export type OutboundKind = "api";

export type BucketRequest = {
	key: string;
	limit: number;
	windowMs: number;
};

export type WindowRow = {
	bucket: string;
	windowStart: number;
	windowMs: number;
	count: number;
	blockedUntil: number | null;
};

export type QuotaDecision = {
	allowed: boolean;
	retryAfter: number;
	limitedBy: string | null;
};

export type RequestQuotaConfig = {
	RATE_LIMIT_PER_MINUTE?: string;
	RATE_LIMIT_GLOBAL_PER_MINUTE?: string;
	WISE_PER_SECOND?: string;
};

export type RequestQuotaPolicy = {
	perMinute: number;
	globalPerMinute: number;
	wisePerSecond: number;
};

export type RequestQuota = {
	consume(requests: BucketRequest[]): Promise<QuotaDecision> | QuotaDecision;
	block(key: string, untilMs: number): Promise<void> | void;
};

export function requestQuotaPolicy(env: RequestQuotaConfig): RequestQuotaPolicy {
	return {
		perMinute: boundedInt(env.RATE_LIMIT_PER_MINUTE, DEFAULT_RATE_LIMIT_PER_MINUTE, MAX_PER_MINUTE),
		globalPerMinute: boundedInt(env.RATE_LIMIT_GLOBAL_PER_MINUTE, DEFAULT_RATE_LIMIT_GLOBAL_PER_MINUTE, MAX_PER_MINUTE),
		wisePerSecond: boundedInt(env.WISE_PER_SECOND, DEFAULT_WISE_PER_SECOND, MAX_PER_SECOND),
	};
}

export function mcpBuckets(clientHash: string, policy: RequestQuotaPolicy): BucketRequest[] {
	return [
		{ key: `mcp:${clientHash}`, limit: policy.perMinute, windowMs: MINUTE_MS },
		{ key: "mcp:global", limit: policy.globalPerMinute, windowMs: MINUTE_MS },
	];
}

export function outboundBucket(kind: OutboundKind, policy: RequestQuotaPolicy): BucketRequest {
	return { key: `wise:${kind}`, limit: policy.wisePerSecond, windowMs: SECOND_MS };
}

export function validateBucketRequest(request: BucketRequest): void {
	if (!BUCKET_KEY.test(request.key)) throw new Error("Invalid rate limit bucket.");
	if (request.windowMs !== MINUTE_MS && request.windowMs !== SECOND_MS) throw new Error("Invalid rate limit window.");
	const max = request.windowMs === MINUTE_MS ? MAX_PER_MINUTE : MAX_PER_SECOND;
	if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > max) {
		throw new Error("Invalid rate limit.");
	}
}

/** SHA-256 hex of the bearer token. The raw token is not returned. */
export async function bearerKey(token: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
	let hex = "";
	for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, "0");
	return hex;
}

export function quotaScope(limitedBy: string | null): string {
	if (limitedBy === "mcp:global") return "global";
	if (limitedBy?.startsWith("mcp:")) return "client";
	if (limitedBy === "wise:api") return "wise";
	return "unknown";
}

/**
 * Fixed windows. A full bucket or an active backoff denies the whole batch,
 * and nothing is incremented. `retryAfter` is long enough for every block.
 */
export function consumeBuckets(
	rows: readonly WindowRow[],
	now: number,
	requests: readonly BucketRequest[],
): { rows: WindowRow[]; decision: QuotaDecision } {
	const byKey = new Map(rows.map((row) => [row.bucket, row]));
	let blocking: { key: string; retryAfter: number } | null = null;

	for (const request of requests) {
		const row = byKey.get(request.key);
		const retryAfter = retryAfterFor(row, request, now);
		if (retryAfter === null) continue;
		if (blocking === null || retryAfter > blocking.retryAfter) blocking = { key: request.key, retryAfter };
	}

	if (blocking) {
		return {
			rows: clearExpiredBlocks(rows, now),
			decision: { allowed: false, retryAfter: blocking.retryAfter, limitedBy: blocking.key },
		};
	}

	const next: WindowRow[] = [];
	for (const request of requests) {
		const row = byKey.get(request.key);
		const windowStart = Math.floor(now / request.windowMs) * request.windowMs;
		const count = row && row.windowStart === windowStart ? row.count : 0;
		next.push({
			bucket: request.key,
			windowStart,
			windowMs: request.windowMs,
			count: count + 1,
			blockedUntil: null,
		});
	}
	return { rows: next, decision: { allowed: true, retryAfter: 0, limitedBy: null } };
}

export function setBlock(rows: readonly WindowRow[], key: string, untilMs: number, now: number): WindowRow[] {
	const existing = rows.find((row) => row.bucket === key);
	return [
		{
			bucket: key,
			windowStart: existing?.windowStart ?? Math.floor(now / SECOND_MS) * SECOND_MS,
			windowMs: existing?.windowMs ?? SECOND_MS,
			count: existing?.count ?? 0,
			blockedUntil: Math.max(existing?.blockedUntil ?? 0, untilMs),
		},
	];
}

/** Milliseconds to wait after a Wise 429. Missing or invalid headers wait 1s, capped at 2 minutes. */
export function retryAfterMs(header: string | null, now: number): number {
	if (header === null || header.trim() === "") return MIN_BACKOFF_MS;
	const seconds = Number(header.trim());
	if (Number.isFinite(seconds)) return clampBackoff(seconds * 1000);
	const date = Date.parse(header.trim());
	if (Number.isFinite(date)) return clampBackoff(date - now);
	return MIN_BACKOFF_MS;
}

export class MemoryQuotaBook {
	private rows: WindowRow[] = [];

	consume(requests: BucketRequest[], now = Date.now()): QuotaDecision {
		const keys = new Set(requests.map((request) => request.key));
		const result = consumeBuckets(
			this.rows.filter((row) => keys.has(row.bucket)),
			now,
			requests,
		);
		this.merge(result.rows);
		return result.decision;
	}

	block(key: string, untilMs: number, now = Date.now()): void {
		this.merge(setBlock(this.rows.filter((row) => row.bucket === key), key, untilMs, now));
	}

	snapshot(): WindowRow[] {
		return this.rows.map((row) => ({ ...row }));
	}

	private merge(updates: WindowRow[]): void {
		const map = new Map(this.rows.map((row) => [row.bucket, row]));
		for (const row of updates) map.set(row.bucket, row);
		this.rows = [...map.values()];
	}
}

function retryAfterFor(row: WindowRow | undefined, request: BucketRequest, now: number): number | null {
	if (row?.blockedUntil != null && row.blockedUntil > now) return secondsUntil(row.blockedUntil, now);
	const windowStart = Math.floor(now / request.windowMs) * request.windowMs;
	const count = row && row.windowStart === windowStart ? row.count : 0;
	if (count >= request.limit) return secondsUntil(windowStart + request.windowMs, now);
	return null;
}

function clearExpiredBlocks(rows: readonly WindowRow[], now: number): WindowRow[] {
	const cleared: WindowRow[] = [];
	for (const row of rows) {
		if (row.blockedUntil !== null && row.blockedUntil <= now) cleared.push({ ...row, blockedUntil: null });
	}
	return cleared;
}

function clampBackoff(ms: number): number {
	if (!Number.isFinite(ms)) return MIN_BACKOFF_MS;
	return Math.min(MAX_BACKOFF_MS, Math.max(MIN_BACKOFF_MS, Math.ceil(ms)));
}

function boundedInt(value: string | undefined, fallback: number, max: number): number {
	if (value === undefined || value.trim() === "") return fallback;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) return fallback;
	return parsed;
}
