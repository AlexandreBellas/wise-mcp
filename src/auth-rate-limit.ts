import { DurableObject } from "cloudflare:workers";
import {
	applyFailure,
	EMPTY_FAILURE_STATE,
	failureStateChanged,
	readLockout,
	sanitizePolicy,
	type AuthFailurePolicy,
	type AuthGate,
	type FailureState,
} from "./rate-limit-policy.js";

type AuthRow = {
	failures_json: string;
	lockout_until_ms: number | null;
};

/**
 * One SQLite Durable Object per client IP. The MCP bearer token and the Wise API
 * token are never written here. Persistence uses the same rules as {@link applyFailure}.
 */
export class AuthRateLimit extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.blockConcurrencyWhile(async () => {
			this.ctx.storage.sql.exec(
				`CREATE TABLE IF NOT EXISTS auth_state (
					id INTEGER PRIMARY KEY CHECK (id = 1),
					failures_json TEXT NOT NULL,
					lockout_until_ms INTEGER
				)`,
			);
			this.ctx.storage.sql.exec(
				"INSERT OR IGNORE INTO auth_state (id, failures_json, lockout_until_ms) VALUES (1, '[]', NULL)",
			);
		});
	}

	/**
	 * Hot path after a token has already been accepted. Does not count the request.
	 * Writes the row only when an expired lockout is cleared.
	 */
	check(): AuthGate {
		return this.ctx.storage.transactionSync(() => {
			const now = Date.now();
			const current = this.read();
			const next = readLockout(current, now);
			this.persistIfChanged(current, next.state);
			return next.gate;
		});
	}

	/** Count one missing or rejected bearer token. Does not extend an active lockout. */
	recordFailure(policy: AuthFailurePolicy): AuthGate {
		const safe = sanitizePolicy(policy);
		return this.ctx.storage.transactionSync(() => {
			const now = Date.now();
			const current = this.read();
			const next = applyFailure(current, now, safe);
			this.persistIfChanged(current, next.state);
			return next.gate;
		});
	}

	private persistIfChanged(before: FailureState, after: FailureState): void {
		if (failureStateChanged(before, after)) this.write(after);
	}

	private read(): FailureState {
		const row = this.ctx.storage.sql
			.exec<AuthRow>("SELECT failures_json, lockout_until_ms FROM auth_state WHERE id = 1")
			.toArray()[0];
		if (!row) return { ...EMPTY_FAILURE_STATE };
		return {
			failures: parseFailures(row.failures_json),
			lockoutUntilMs: row.lockout_until_ms,
		};
	}

	private write(state: FailureState): void {
		this.ctx.storage.sql.exec(
			"UPDATE auth_state SET failures_json = ?, lockout_until_ms = ? WHERE id = 1",
			JSON.stringify(state.failures),
			state.lockoutUntilMs,
		);
	}
}

function parseFailures(value: string): number[] {
	try {
		const parsed = JSON.parse(value) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((item): item is number => typeof item === "number" && Number.isFinite(item));
	} catch {
		return [];
	}
}
