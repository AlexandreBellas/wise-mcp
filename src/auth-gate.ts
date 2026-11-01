import { bearerToken } from "./bearer.js";
import { clientAddress } from "./client-address.js";
import {
	authFailurePolicy,
	type AuthFailurePolicy,
	type AuthGate,
	type RateLimitConfig,
} from "./rate-limit-policy.js";
import { tokensMatch } from "./tokens.js";

const MAX_BEARER_LENGTH = 4096;

export type AuthLimiter = {
	check(): Promise<AuthGate> | AuthGate;
	recordFailure(policy: AuthFailurePolicy): Promise<AuthGate> | AuthGate;
};

export type AuthEnv = RateLimitConfig & {
	MCP_AUTH_TOKEN?: string;
	AUTH_RATE_LIMIT: {
		getByName(name: string): AuthLimiter;
	};
};

/**
 * Lockouts this isolate has already confirmed. A hit fails closed with no
 * Durable Object call. A miss is not treated as allowed. Never stores tokens.
 */
const lockoutUntilMs = new Map<string, number>();
const MAX_CACHED_LOCKOUTS = 1024;

/** Test hook: drop the in-isolate lockout cache. */
export function clearAuthLockoutCache(): void {
	lockoutUntilMs.clear();
}

/** Test hook: cache keys are client IPs, never bearer tokens. */
export function authLockoutCacheKeys(): string[] {
	return [...lockoutUntilMs.keys()];
}

/**
 * Returns a response when the request must be refused, or null when it may proceed.
 * Fails closed when MCP_AUTH_TOKEN is not configured.
 */
export async function authorizeMcpRequest(request: Request, env: AuthEnv): Promise<Response | null> {
	const expected = env.MCP_AUTH_TOKEN?.trim() ?? "";
	if (expected.length === 0) {
		console.error(JSON.stringify({ message: "MCP_AUTH_TOKEN is not configured", path: new URL(request.url).pathname }));
		return jsonRpcError(503, -32000, "MCP authentication is not configured.");
	}

	const ip = clientAddress(request);
	const cachedRetryAfter = cachedLockout(ip, Date.now());
	if (cachedRetryAfter !== null) return lockedOut(cachedRetryAfter);

	const limiter = env.AUTH_RATE_LIMIT.getByName(`ip:${ip}`);
	const policy = authFailurePolicy(env);

	try {
		const gate = await limiter.check();
		if (gate.locked) {
			rememberLockout(ip, gate.retryAfter, Date.now());
			return lockedOut(gate.retryAfter);
		}
	} catch (error) {
		return limiterUnavailable(error);
	}

	const token = bearerToken(request.headers.get("Authorization"));
	if (token === null || token.length > MAX_BEARER_LENGTH || !(await tokensMatch(token, expected))) {
		return reject(limiter, policy, ip);
	}
	return null;
}

async function reject(limiter: AuthLimiter, policy: AuthFailurePolicy, ip: string): Promise<Response> {
	try {
		const gate = await limiter.recordFailure(policy);
		if (gate.locked) {
			rememberLockout(ip, gate.retryAfter, Date.now());
			if (gate.justLocked) {
				console.error(JSON.stringify({ message: "MCP auth lockout started", ip, retryAfter: gate.retryAfter }));
			}
			return lockedOut(gate.retryAfter);
		}
	} catch (error) {
		return limiterUnavailable(error);
	}
	return jsonRpcError(401, -32001, "Unauthorized", { "WWW-Authenticate": "Bearer" });
}

function limiterUnavailable(error: unknown): Response {
	console.error(
		JSON.stringify({
			message: "MCP auth limiter failed; refusing request",
			error: error instanceof Error ? error.message : "unknown",
		}),
	);
	return jsonRpcError(503, -32000, "Authentication protection is unavailable.");
}

function cachedLockout(ip: string, now: number): number | null {
	const until = lockoutUntilMs.get(ip);
	if (until === undefined) return null;
	const remainingMs = until - now;
	if (remainingMs <= 0) {
		lockoutUntilMs.delete(ip);
		return null;
	}
	return Math.max(1, Math.ceil(remainingMs / 1000));
}

function rememberLockout(ip: string, retryAfterSeconds: number, now: number): void {
	if (lockoutUntilMs.size >= MAX_CACHED_LOCKOUTS && !lockoutUntilMs.has(ip)) {
		const oldest = lockoutUntilMs.keys().next().value;
		if (oldest !== undefined) lockoutUntilMs.delete(oldest);
	}
	lockoutUntilMs.set(ip, now + retryAfterSeconds * 1000);
}

function lockedOut(retryAfter: number): Response {
	return jsonRpcError(429, -32029, "Too many failed authentication attempts. Try again later.", {
		"retry-after": String(retryAfter),
	});
}

export function jsonRpcError(
	status: number,
	code: number,
	message: string,
	extraHeaders: Record<string, string> = {},
): Response {
	return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code, message } }), {
		status,
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
			...extraHeaders,
		},
	});
}
