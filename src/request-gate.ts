import { jsonRpcError } from "./auth-gate.js";
import { bearerToken } from "./bearer.js";
import {
	bearerKey,
	mcpBuckets,
	outboundBucket,
	QUOTA_INSTANCE,
	quotaScope,
	requestQuotaPolicy,
	retryAfterMs,
	type OutboundKind,
	type RequestQuota,
	type RequestQuotaConfig,
} from "./request-quota.js";

const MAX_BEARER_LENGTH = 4096;

export type QuotaEnv = RequestQuotaConfig & {
	REQUEST_RATE_LIMIT: {
		getByName(name: string): RequestQuota;
	};
};

export type OutboundBudget = {
	acquire(kind: OutboundKind): Promise<void>;
	observe(kind: OutboundKind, response: Response): Promise<void>;
};

/**
 * Counts one authenticated MCP request. Health checks never reach this.
 * A Durable Object failure refuses the request instead of running unlimited.
 */
export async function enforceRequestQuota(request: Request, env: QuotaEnv): Promise<Response | null> {
	const token = bearerToken(request.headers.get("Authorization"));
	if (token === null || token.length === 0 || token.length > MAX_BEARER_LENGTH) {
		return jsonRpcError(401, -32001, "Unauthorized", { "WWW-Authenticate": "Bearer" });
	}

	const policy = requestQuotaPolicy(env);
	try {
		const decision = await env.REQUEST_RATE_LIMIT.getByName(QUOTA_INSTANCE).consume(
			mcpBuckets(await bearerKey(token), policy),
		);
		if (!decision.allowed) {
			console.error(
				JSON.stringify({
					message: "MCP request rate limit",
					scope: quotaScope(decision.limitedBy),
					retryAfter: decision.retryAfter,
				}),
			);
			return jsonRpcError(429, -32029, "Too many requests. Try again later.", {
				"retry-after": String(decision.retryAfter),
			});
		}
		return null;
	} catch (error) {
		console.error(
			JSON.stringify({
				message: "MCP request limiter failed; refusing request",
				error: error instanceof Error ? error.message : "unknown",
			}),
		);
		return jsonRpcError(503, -32000, "Request limiting is unavailable.");
	}
}

/** Shared Wise budget. A denial throws before fetch. A 429 is remembered and not retried. */
export function outboundBudget(env: QuotaEnv): OutboundBudget {
	const quota = env.REQUEST_RATE_LIMIT.getByName(QUOTA_INSTANCE);
	const policy = requestQuotaPolicy(env);
	return {
		async acquire(kind) {
			let decision;
			try {
				decision = await quota.consume([outboundBucket(kind, policy)]);
			} catch (error) {
				console.error(
					JSON.stringify({
						message: "Wise limiter failed; refusing outbound call",
						error: error instanceof Error ? error.message : "unknown",
					}),
				);
				throw new Error("Wise request limit is unavailable.");
			}
			if (!decision.allowed) {
				const seconds = decision.retryAfter;
				const unit = seconds === 1 ? "second" : "seconds";
				throw new Error(`Wise ${kind} limit reached. Retry after ${seconds} ${unit}.`);
			}
		},
		async observe(kind, response) {
			if (response.status !== 429) return;
			const until = Date.now() + retryAfterMs(response.headers.get("retry-after"), Date.now());
			try {
				await quota.block(`wise:${kind}`, until);
			} catch (error) {
				console.error(
					JSON.stringify({
						message: "Failed to record Wise backoff",
						error: error instanceof Error ? error.message : "unknown",
					}),
				);
			}
		},
	};
}
