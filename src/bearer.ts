/** RFC 6750: the scheme is case-insensitive. The credential is one token. */
export function bearerToken(header: string | null): string | null {
	if (header === null) return null;
	const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
	return match?.[1] ?? null;
}
