import type { Config } from "./config.js";
import { MAX_ERROR_BODY_BYTES, MAX_RESPONSE_BYTES, SERVER_NAME, SERVER_VERSION } from "./constants.js";
import { httpFetch } from "./http-fetch.js";
import { assertSafePath } from "./paths.js";
import type { OutboundBudget } from "./request-gate.js";
import {
	SCA_KEY_INVALID_MESSAGE,
	SCA_NOT_CONFIGURED_MESSAGE,
	SCA_NO_TOKEN_MESSAGE,
	SCA_REJECTED_MESSAGE,
	SCA_TOKEN_UNUSABLE_MESSAGE,
	ScaConfigError,
	signScaToken,
} from "./sca.js";

const QUERY_KEY = /^[A-Za-z][A-Za-z0-9]{0,32}$/;
const OTT = /^[A-Za-z0-9._~+/=-]{8,512}$/;
const USER_AGENT = `${SERVER_NAME}/${SERVER_VERSION}`;

type ScaProof = { token: string; signature: string };

export class WiseApiError extends Error {
	readonly status: number;
	readonly sca: boolean;
	readonly retryAfter: number | null;

	constructor(message: string, status: number, sca = false, retryAfter: number | null = null) {
		super(message);
		this.name = "WiseApiError";
		this.status = status;
		this.sca = sca;
		this.retryAfter = retryAfter;
	}
}

/**
 * Read-only Wise API client.
 * Every call is a GET. There is no method on this class that sends another verb.
 */
export class WiseClient {
	constructor(
		private config: Config,
		private budget?: OutboundBudget,
	) {}

	get hasCredentials(): boolean {
		return this.config.configError === null && this.config.apiToken.length > 0;
	}

	async get<T = unknown>(path: string, params?: Record<string, string | undefined>): Promise<T> {
		if (this.config.configError) throw new WiseApiError(this.config.configError, 0);
		if (this.config.apiToken.length === 0) {
			throw new WiseApiError("WISE_API_TOKEN is not configured.", 0);
		}
		const url = this.buildUrl(`/${this.config.apiVersion}${path}`, params);
		return this.getUrl<T>(url);
	}

	/** Legacy personal-token bank-details list. Not part of the quarterly path prefix. */
	async getLegacyAccountDetails<T = unknown>(profileId: string, currency?: string): Promise<T> {
		if (this.config.configError) throw new WiseApiError(this.config.configError, 0);
		if (this.config.apiToken.length === 0) {
			throw new WiseApiError("WISE_API_TOKEN is not configured.", 0);
		}
		const url = this.buildUrl(`/v1/profiles/${profileId}/account-details`, { currency });
		return this.getUrl<T>(url);
	}

	private async getUrl<T>(url: string): Promise<T> {
		if (this.config.apiToken.length > 0 && url.includes(this.config.apiToken)) {
			throw new Error("Refusing to put the Wise API token in a URL.");
		}
		const first = await this.send(url);
		const token = oneTimeToken(first);
		if (token === undefined) return this.handleResponse<T>(first, []);
		await drain(first);
		if (token === null) {
			console.error(JSON.stringify({ message: "Wise SCA challenge", status: 403 }));
			throw new WiseApiError(SCA_TOKEN_UNUSABLE_MESSAGE, 403, true);
		}
		const signature = await this.signChallenge(token);
		const second = await this.send(url, { token, signature });
		return this.handleResponse<T>(second, [token, signature], true);
	}

	private async send(url: string, sca?: ScaProof): Promise<Response> {
		await this.budget?.acquire("api");
		const res = await getOnly(url, this.config.apiToken, sca);
		await this.budget?.observe("api", res);
		return res;
	}

	private async signChallenge(token: string): Promise<string> {
		try {
			return await signScaToken(this.config.scaPrivateKey, token);
		} catch (error) {
			const missing = error instanceof ScaConfigError && !error.keyPresent;
			console.error(JSON.stringify({ message: missing ? "Wise SCA challenge" : "Wise SCA key cannot sign", status: 403 }));
			if (error instanceof ScaConfigError) throw new WiseApiError(error.message, 403, true);
			throw new WiseApiError(SCA_KEY_INVALID_MESSAGE, 403, true);
		}
	}

	private buildUrl(path: string, params?: Record<string, string | undefined>): string {
		assertSafePath(path);
		const url = new URL(`${this.config.baseUrl}${path}`);
		if (url.origin !== this.config.baseUrl) {
			throw new Error("Refusing to request outside the Wise API.");
		}
		if (params) {
			for (const [key, value] of Object.entries(params)) {
				if (value === undefined || value === "") continue;
				if (!QUERY_KEY.test(key) || value.length > 1024 || hasControlChar(value)) {
					throw new Error("Refusing an unsafe query parameter.");
				}
				url.searchParams.set(key, value);
			}
		}
		if (url.origin !== this.config.baseUrl || !url.pathname.startsWith("/")) {
			throw new Error("Refusing to request outside the Wise API.");
		}
		return url.toString();
	}

	private async handleResponse<T>(res: Response, extraSecrets: string[], signedRetry = false): Promise<T> {
		if (res.status >= 300 && res.status < 400) {
			await cancelBody(res);
			throw new WiseApiError(`Wise API error (HTTP ${res.status}).`, res.status);
		}
		const sca = res.status === 403 && hasScaHeader(res.headers);
		const limit = res.ok ? MAX_RESPONSE_BYTES : MAX_ERROR_BODY_BYTES;
		const body = await readBody(res, limit);
		if (res.status === 403 && (sca || bodySaysSca(body.text))) {
			console.error(JSON.stringify({ message: signedRetry ? "Wise SCA signature rejected" : "Wise SCA challenge", status: 403 }));
			if (signedRetry) throw new WiseApiError(SCA_REJECTED_MESSAGE, 403, true);
			throw new WiseApiError(this.config.scaPrivateKey === null ? SCA_NOT_CONFIGURED_MESSAGE : SCA_NO_TOKEN_MESSAGE, 403, true);
		}
		if (!res.ok) {
			const retryAfter = res.status === 429 ? retryAfterSeconds(res.headers.get("retry-after")) : null;
			const detail = body.truncated ? undefined : publicDetail(body.text, this.secretValues(extraSecrets));
			console.error(
				JSON.stringify({
					message: "Wise API request failed",
					status: res.status,
					...(retryAfter !== null ? { retryAfter } : {}),
				}),
			);
			const suffix = detail ? `: ${detail}` : ".";
			const retry = retryAfter !== null ? ` Retry after ${retryAfter} seconds.` : "";
			throw new WiseApiError(`Wise API error (HTTP ${res.status})${suffix}${retry}`, res.status, false, retryAfter);
		}
		if (body.truncated) throw new WiseApiError("Wise response exceeded the size limit.", res.status);
		if (res.status === 204 || body.text.length === 0) return {} as T;
		try {
			return JSON.parse(body.text) as T;
		} catch {
			throw new WiseApiError("Wise returned a response that was not JSON.", res.status);
		}
	}

	private secretValues(extra: string[]): string[] {
		return [this.config.apiToken, this.config.scaPrivateKey ?? "", ...extra].filter((value) => value.length > 0);
	}
}

/**
 * A usable one-time token, null when the header is present but unsafe to resend,
 * or undefined when this 403 is not an x-2fa-approval challenge.
 */
function oneTimeToken(res: Response): string | null | undefined {
	if (res.status !== 403) return undefined;
	const raw = res.headers.get("x-2fa-approval");
	if (raw === null || raw.trim() === "") return undefined;
	const token = raw.trim();
	return OTT.test(token) ? token : null;
}

export function hasScaHeader(headers: Headers): boolean {
	const approval = headers.get("x-2fa-approval");
	if (approval !== null && approval.trim() !== "") return true;
	const result = headers.get("x-2fa-approval-result");
	return result !== null && result.trim() !== "";
}

export function bodySaysSca(body: string): boolean {
	const lower = body.toLowerCase();
	return (
		lower.includes("strong customer authentication") ||
		lower.includes("strong_customer_authentication") ||
		lower.includes("strong.customer.authentication")
	);
}

function publicDetail(body: string, secrets: string[]): string | undefined {
	if (body.length === 0 || containsSecret(body, secrets)) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== "object") return undefined;
	const obj = parsed as Record<string, unknown>;
	const parts = [publicText(obj.error, secrets), publicText(obj.message, secrets), errorItem(obj.errors, secrets)];
	const detail = parts.filter((part): part is string => part !== undefined).join(": ");
	return detail.length > 0 ? detail : undefined;
}

function errorItem(value: unknown, secrets: string[]): string | undefined {
	if (!Array.isArray(value) || value.length === 0) return undefined;
	const first = value[0];
	if (!first || typeof first !== "object") return undefined;
	const item = first as Record<string, unknown>;
	return publicText(item.code, secrets) ?? publicText(item.message, secrets);
}

function publicText(value: unknown, secrets: string[]): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = value.trim();
	if (text.length === 0 || text.length > 160) return undefined;
	if (!/^[A-Za-z0-9][A-Za-z0-9 ._:/()-]{0,159}$/.test(text)) return undefined;
	if (text.includes("@") || containsSecret(text, secrets)) return undefined;
	return text;
}

function hasControlChar(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code <= 31 || code === 127) return true;
	}
	return false;
}

function containsSecret(value: string, secrets: string[]): boolean {
	return secrets.some((secret) => secret.length > 0 && value.includes(secret));
}

function retryAfterSeconds(header: string | null): number | null {
	if (header === null || header.trim() === "") return null;
	const seconds = Number(header.trim());
	if (!Number.isFinite(seconds) || seconds < 0) return null;
	return Math.ceil(seconds);
}

async function readBody(res: Response, limit: number): Promise<{ text: string; truncated: boolean }> {
	const reader = res.body?.getReader();
	if (!reader) return { text: "", truncated: false };
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			total += value.byteLength;
			if (total > limit) {
				await reader.cancel().catch(() => undefined);
				return { text: "", truncated: true };
			}
			chunks.push(value);
		}
	} catch {
		return { text: "", truncated: false };
	}
	const merged = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		merged.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { text: new TextDecoder().decode(merged), truncated: false };
}

async function cancelBody(res: Response): Promise<void> {
	await res.body?.cancel().catch(() => undefined);
}

async function drain(res: Response): Promise<void> {
	await readBody(res, MAX_ERROR_BODY_BYTES);
}

/** GET only. A non-GET method never leaves this server. The SCA retry is the same GET plus two headers. */
function getOnly(url: string, token: string, sca?: ScaProof): Promise<Response> {
	const headers: Record<string, string> = {
		Accept: "application/json",
		Authorization: `Bearer ${token}`,
		"User-Agent": USER_AGENT,
	};
	if (sca !== undefined) {
		headers["x-2fa-approval"] = sca.token;
		headers["X-Signature"] = sca.signature;
	}
	return httpFetch(url, {
		method: "GET",
		headers,
		redirect: "manual",
		cache: "no-store",
	});
}
