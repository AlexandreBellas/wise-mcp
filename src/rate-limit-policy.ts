/** Defaults match the investbrain-mcp limiter: 10 failures in 15 minutes, then 30 minutes. */
export const DEFAULT_AUTH_FAILURE_LIMIT = 10;
export const DEFAULT_AUTH_FAILURE_WINDOW_SECONDS = 15 * 60;
export const DEFAULT_AUTH_LOCKOUT_SECONDS = 30 * 60;

const MAX_LIMIT = 1_000;
const MAX_SECONDS = 24 * 60 * 60;

export type AuthFailurePolicy = {
	limit: number;
	windowMs: number;
	lockoutMs: number;
};

export type AuthGate = {
	locked: boolean;
	retryAfter: number;
	justLocked: boolean;
};

export const OPEN_GATE: AuthGate = { locked: false, retryAfter: 0, justLocked: false };

export type FailureState = {
	failures: number[];
	lockoutUntilMs: number | null;
};

export const EMPTY_FAILURE_STATE: FailureState = { failures: [], lockoutUntilMs: null };

export type RateLimitConfig = {
	AUTH_FAILURE_LIMIT?: string;
	AUTH_FAILURE_WINDOW_SECONDS?: string;
	AUTH_LOCKOUT_SECONDS?: string;
};

/**
 * An expired lockout is cleared so the next failure starts a new window.
 * An active lockout is returned unchanged.
 */
export function readLockout(
	state: FailureState,
	now: number,
): { state: FailureState; gate: AuthGate } {
	if (state.lockoutUntilMs === null) return { state, gate: OPEN_GATE };
	if (state.lockoutUntilMs > now) {
		return {
			state,
			gate: {
				locked: true,
				retryAfter: secondsUntil(state.lockoutUntilMs, now),
				justLocked: false,
			},
		};
	}
	return { state: { ...EMPTY_FAILURE_STATE }, gate: OPEN_GATE };
}

/**
 * Count one missing or rejected bearer token.
 * Does not record the attempt, and does not extend the lockout, while one is active.
 */
export function applyFailure(
	state: FailureState,
	now: number,
	policy: AuthFailurePolicy,
): { state: FailureState; gate: AuthGate } {
	const current = readLockout(state, now);
	if (current.gate.locked) return current;

	const windowStart = now - policy.windowMs;
	const failures = current.state.failures.filter((at) => at >= windowStart);
	failures.push(now);
	if (failures.length < policy.limit) {
		return { state: { failures, lockoutUntilMs: null }, gate: OPEN_GATE };
	}

	const until = now + policy.lockoutMs;
	return {
		state: { failures: [], lockoutUntilMs: until },
		gate: {
			locked: true,
			retryAfter: secondsUntil(until, now),
			justLocked: true,
		},
	};
}

export function authFailurePolicy(env: RateLimitConfig): AuthFailurePolicy {
	return sanitizePolicy({
		limit: positiveInt(env.AUTH_FAILURE_LIMIT, DEFAULT_AUTH_FAILURE_LIMIT),
		windowMs: positiveInt(env.AUTH_FAILURE_WINDOW_SECONDS, DEFAULT_AUTH_FAILURE_WINDOW_SECONDS) * 1000,
		lockoutMs: positiveInt(env.AUTH_LOCKOUT_SECONDS, DEFAULT_AUTH_LOCKOUT_SECONDS) * 1000,
	});
}

export function sanitizePolicy(policy: AuthFailurePolicy): AuthFailurePolicy {
	return {
		limit: clamp(policy.limit, DEFAULT_AUTH_FAILURE_LIMIT, MAX_LIMIT),
		windowMs: clamp(policy.windowMs, DEFAULT_AUTH_FAILURE_WINDOW_SECONDS * 1000, MAX_SECONDS * 1000),
		lockoutMs: clamp(policy.lockoutMs, DEFAULT_AUTH_LOCKOUT_SECONDS * 1000, MAX_SECONDS * 1000),
	};
}

function positiveInt(value: string | undefined, fallback: number): number {
	if (value === undefined || value.trim() === "") return fallback;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 1) return fallback;
	return parsed;
}

function clamp(value: number, fallback: number, max: number): number {
	if (!Number.isSafeInteger(value) || value < 1 || value > max) return fallback;
	return value;
}

/** True when a Durable Object row would change if `after` replaced `before`. */
export function failureStateChanged(before: FailureState, after: FailureState): boolean {
	if (before.lockoutUntilMs !== after.lockoutUntilMs) return true;
	if (before.failures.length !== after.failures.length) return true;
	for (let index = 0; index < before.failures.length; index += 1) {
		if (before.failures[index] !== after.failures[index]) return true;
	}
	return false;
}

export function secondsUntil(untilMs: number, now: number): number {
	return Math.max(1, Math.ceil((untilMs - now) / 1000));
}
