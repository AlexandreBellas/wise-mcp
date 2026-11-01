import { WISE_PRODUCTION_ORIGIN, WISE_SANDBOX_ORIGIN } from "./constants.js";

const VERSION = /^\d{4}Q[1-4]$/;
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const ID = /^[1-9][0-9]{0,17}$/;

/**
 * Free-function wrapper around the global fetch.
 * Calling fetch as a method of another object throws "Illegal invocation" on Workers.
 * Outbound calls are GET only, and only to the Wise production or sandbox host.
 */
export async function httpFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
	const url = toUrl(input);
	const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
	if (!isAllowedOutbound(url, method)) {
		throw new Error("Refusing to request outside the Wise API.");
	}
	return fetch(input, init);
}

export function isAllowedOutbound(url: URL, method: string): boolean {
	if (method !== "GET") return false;
	if (url.username !== "" || url.password !== "" || url.hash !== "") return false;
	if (url.origin !== WISE_PRODUCTION_ORIGIN && url.origin !== WISE_SANDBOX_ORIGIN) return false;
	return isVersionedRead(url.pathname) || isLegacyAccountDetails(url.pathname);
}

function isVersionedRead(pathname: string): boolean {
	const parts = pathname.split("/").filter((part) => part.length > 0);
	if (pathname !== `/${parts.join("/")}`) return false;
	const [version, ...rest] = parts;
	if (version === undefined || !VERSION.test(version) || rest.length === 0) return false;
	return rest.every((part) => part === "statement.json" || SEGMENT.test(part));
}

/** Personal-token bank details list. The 2026Q4 reference no longer documents this GET. */
function isLegacyAccountDetails(pathname: string): boolean {
	const parts = pathname.split("/").filter((part) => part.length > 0);
	return (
		pathname === `/${parts.join("/")}` &&
		parts.length === 4 &&
		parts[0] === "v1" &&
		parts[1] === "profiles" &&
		ID.test(parts[2] ?? "") &&
		parts[3] === "account-details"
	);
}

function toUrl(input: RequestInfo | URL): URL {
	if (typeof input === "string" || input instanceof URL) return new URL(input);
	return new URL(input.url);
}
