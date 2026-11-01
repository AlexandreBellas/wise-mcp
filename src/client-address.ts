/** Cloudflare sets this header and overwrites any client-supplied value. */
export function clientAddress(request: Request): string {
	const raw = request.headers.get("CF-Connecting-IP")?.trim() ?? "";
	if (isIpv4(raw)) return raw;
	if (isIpv6(raw)) return raw.toLowerCase();
	return "unknown";
}

function isIpv4(value: string): boolean {
	const parts = value.split(".");
	if (parts.length !== 4) return false;
	return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function isIpv6(value: string): boolean {
	if (value.length < 2 || value.length > 45 || !value.includes(":")) return false;
	return /^[0-9a-f:.]+$/i.test(value);
}
