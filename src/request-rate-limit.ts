import { DurableObject } from "cloudflare:workers";
import {
	consumeBuckets,
	SECOND_MS,
	setBlock,
	validateBucketRequest,
	type BucketRequest,
	type QuotaDecision,
	type WindowRow,
} from "./request-quota.js";

const MAX_BACKOFF_MS = 120_000;
const MIN_BACKOFF_MS = 1_000;

type WindowSqlRow = {
	bucket: string;
	window_start: number;
	window_ms: number;
	count: number;
	blocked_until: number | null;
};

/**
 * One SQLite object named "quotas" holds the per-client counters, the global
 * cap, and the Wise outbound window. Those counters have to commit together.
 * 600 requests a minute is the whole Worker, so one object is the coordination
 * point rather than a fan-out cache.
 * Callers pass a SHA-256 of the bearer token. The raw token is never stored.
 */
export class RequestRateLimit extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.blockConcurrencyWhile(async () => {
			this.ctx.storage.sql.exec(
				`CREATE TABLE IF NOT EXISTS windows (
					bucket TEXT PRIMARY KEY,
					window_start INTEGER NOT NULL,
					window_ms INTEGER NOT NULL,
					count INTEGER NOT NULL,
					blocked_until INTEGER
				)`,
			);
		});
	}

	consume(requests: BucketRequest[]): QuotaDecision {
		if (!Array.isArray(requests) || requests.length === 0 || requests.length > 4) {
			throw new Error("Invalid rate limit request.");
		}
		for (const request of requests) validateBucketRequest(request);
		return this.ctx.storage.transactionSync(() => {
			const now = Date.now();
			this.prune(now);
			const rows = this.read(requests.map((request) => request.key));
			const result = consumeBuckets(rows, now, requests);
			this.write(result.rows);
			return result.decision;
		});
	}

	/** Hold an outbound bucket until Wise's Retry-After elapses. Does not call Wise again. */
	block(key: string, untilMs: number): void {
		validateBucketRequest({ key, limit: 1, windowMs: SECOND_MS });
		if (!Number.isFinite(untilMs)) throw new Error("Invalid backoff.");
		const now = Date.now();
		const until = Math.min(Math.max(untilMs, now + MIN_BACKOFF_MS), now + MAX_BACKOFF_MS);
		this.ctx.storage.transactionSync(() => {
			this.write(setBlock(this.read([key]), key, until, now));
		});
	}

	private prune(now: number): void {
		this.ctx.storage.sql.exec(
			`DELETE FROM windows
			 WHERE (blocked_until IS NULL OR blocked_until <= ?)
			   AND window_start + window_ms <= ?`,
			now,
			now,
		);
	}

	private read(keys: string[]): WindowRow[] {
		const rows: WindowRow[] = [];
		for (const key of keys) {
			const row = this.ctx.storage.sql
				.exec<WindowSqlRow>(
					"SELECT bucket, window_start, window_ms, count, blocked_until FROM windows WHERE bucket = ?",
					key,
				)
				.toArray()[0];
			if (!row) continue;
			rows.push({
				bucket: row.bucket,
				windowStart: row.window_start,
				windowMs: row.window_ms,
				count: row.count,
				blockedUntil: row.blocked_until,
			});
		}
		return rows;
	}

	private write(rows: WindowRow[]): void {
		for (const row of rows) {
			this.ctx.storage.sql.exec("DELETE FROM windows WHERE bucket = ?", row.bucket);
			this.ctx.storage.sql.exec(
				"INSERT INTO windows (bucket, window_start, window_ms, count, blocked_until) VALUES (?, ?, ?, ?, ?)",
				row.bucket,
				row.windowStart,
				row.windowMs,
				row.count,
				row.blockedUntil,
			);
		}
	}
}
