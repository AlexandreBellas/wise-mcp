import {
	applyFailure,
	EMPTY_FAILURE_STATE,
	readLockout,
	sanitizePolicy,
	type AuthFailurePolicy,
	type FailureState,
} from "../src/rate-limit-policy.js";
import type { AppEnv } from "../src/http.js";
import type { AuthLimiter } from "../src/auth-gate.js";
import { MemoryQuotaBook, type RequestQuota } from "../src/request-quota.js";

export const MCP_TOKEN = "mcp-auth-token-test-value";
export const WISE_TOKEN = "wise-api-token-test-value";

export class MemoryAuthLimiter implements AuthLimiter {
	state: FailureState = { failures: [], lockoutUntilMs: EMPTY_FAILURE_STATE.lockoutUntilMs };

	check() {
		const next = readLockout(this.state, Date.now());
		this.state = { failures: [...next.state.failures], lockoutUntilMs: next.state.lockoutUntilMs };
		return next.gate;
	}

	recordFailure(policy: AuthFailurePolicy) {
		const next = applyFailure(this.state, Date.now(), sanitizePolicy(policy));
		this.state = { failures: [...next.state.failures], lockoutUntilMs: next.state.lockoutUntilMs };
		return next.gate;
	}
}

export function memoryRequestQuota(): RequestQuota {
	const book = new MemoryQuotaBook();
	return {
		consume(requests) {
			return book.consume(requests);
		},
		block(key, untilMs) {
			book.block(key, untilMs);
		},
	};
}

export function testEnv(overrides: Partial<AppEnv> = {}): AppEnv {
	const limiters = new Map<string, MemoryAuthLimiter>();
	const quota = memoryRequestQuota();
	return {
		WISE_API_TOKEN: WISE_TOKEN,
		WISE_API_BASE: "https://api.wise.com",
		WISE_API_VERSION: "2026Q4",
		MCP_AUTH_TOKEN: MCP_TOKEN,
		AUTH_FAILURE_LIMIT: "10",
		AUTH_FAILURE_WINDOW_SECONDS: "900",
		AUTH_LOCKOUT_SECONDS: "1800",
		RATE_LIMIT_PER_MINUTE: "60",
		RATE_LIMIT_GLOBAL_PER_MINUTE: "600",
		WISE_PER_SECOND: "5",
		AUTH_RATE_LIMIT: {
			getByName(name: string) {
				let limiter = limiters.get(name);
				if (limiter === undefined) {
					limiter = new MemoryAuthLimiter();
					limiters.set(name, limiter);
				}
				return limiter;
			},
		},
		REQUEST_RATE_LIMIT: {
			getByName() {
				return quota;
			},
		},
		...overrides,
	};
}

export function mcpRequest(
	init: {
		method?: string;
		token?: string | null;
		ip?: string;
		body?: unknown;
		path?: string;
	} = {},
): Request {
	const headers = new Headers();
	headers.set("CF-Connecting-IP", init.ip ?? "203.0.113.10");
	headers.set("Accept", "application/json, text/event-stream");
	headers.set("Content-Type", "application/json");
	if (init.token !== null && init.token !== undefined) {
		headers.set("Authorization", `Bearer ${init.token}`);
	}
	return new Request(`https://wise-mcp.example.workers.dev${init.path ?? "/mcp"}`, {
		method: init.method ?? "POST",
		headers,
		body: init.body === undefined ? undefined : JSON.stringify(init.body),
	});
}

export type FetchCall = {
	url: string;
	method: string;
	authorization: string | null;
};

/**
 * Fetch double that throws TypeError "Illegal invocation" when called as a
 * method of an object other than the global. A free call (`this` undefined)
 * and a call on `globalThis` both succeed.
 */
export function invocationSensitiveFetch(
	handler: (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>,
): typeof fetch {
	const fetchImpl = async function (this: unknown, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
		if (this !== globalThis && this !== undefined) {
			throw new TypeError("Illegal invocation");
		}
		return handler(input, init);
	};
	return fetchImpl as typeof fetch;
}

export function jsonRpc(method: string, id: number, params: unknown = {}): unknown {
	return { jsonrpc: "2.0", id, method, params };
}

export function toolText(payload: unknown): string {
	const result = payload as { result?: { content?: { text?: string }[]; isError?: boolean } };
	return result.result?.content?.[0]?.text ?? "";
}
