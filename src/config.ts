import { DEFAULT_WISE_API_BASE, DEFAULT_WISE_API_VERSION, WISE_PRODUCTION_ORIGIN, WISE_SANDBOX_ORIGIN } from "./constants.js";

const VERSION = /^\d{4}Q[1-4]$/;
const ALLOWED_ORIGINS = new Set([WISE_PRODUCTION_ORIGIN, WISE_SANDBOX_ORIGIN]);

export interface Config {
	apiToken: string;
	baseUrl: string;
	apiVersion: string;
	configError: string | null;
}

export interface CredentialEnv {
	WISE_API_TOKEN?: string;
	WISE_API_BASE?: string;
	WISE_API_VERSION?: string;
}

export function loadConfig(env: CredentialEnv): Config {
	const base = normalizeBase(env.WISE_API_BASE);
	const version = normalizeVersion(env.WISE_API_VERSION);
	const configError = base.error ?? version.error;
	return {
		apiToken: (env.WISE_API_TOKEN ?? "").trim(),
		baseUrl: base.baseUrl,
		apiVersion: version.apiVersion,
		configError,
	};
}

export function hasCredentials(config: Config): boolean {
	return config.configError === null && config.apiToken.length > 0;
}

function normalizeBase(value: string | undefined): { baseUrl: string; error: string | null } {
	const raw = (value ?? "").trim();
	const fallback = raw.length === 0 ? DEFAULT_WISE_API_BASE : raw;
	let url: URL;
	try {
		url = new URL(fallback);
	} catch {
		return { baseUrl: "", error: "WISE_API_BASE is not a valid URL." };
	}
	const path = url.pathname.replace(/\/+$/, "");
	if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "" || path !== "") {
		return {
			baseUrl: "",
			error: "WISE_API_BASE must be the Wise host only, with no path, query, fragment, or credentials.",
		};
	}
	if (url.protocol !== "https:" || !ALLOWED_ORIGINS.has(url.origin)) {
		return { baseUrl: "", error: "WISE_API_BASE must be https://api.wise.com or https://api.wise-sandbox.com." };
	}
	return { baseUrl: url.origin, error: null };
}

function normalizeVersion(value: string | undefined): { apiVersion: string; error: string | null } {
	const raw = (value ?? "").trim();
	const version = raw.length === 0 ? DEFAULT_WISE_API_VERSION : raw;
	if (!VERSION.test(version)) {
		return { apiVersion: "", error: "WISE_API_VERSION must look like 2026Q4." };
	}
	return { apiVersion: version, error: null };
}
