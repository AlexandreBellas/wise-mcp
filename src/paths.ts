/** One URL path segment: ASCII letters, digits, "_" and "-". No dots, slashes, or percent signs. */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** Wise ids are int64. Kept as decimal text so values above 2^53 are not rounded. */
const ID = /^[1-9][0-9]{0,17}$/;

export class PathParamError extends Error {
	constructor(name: string) {
		super(`${name} is not a valid path parameter.`);
		this.name = "PathParamError";
	}
}

export class UnsafePathError extends Error {
	constructor() {
		super("Refusing to request an unsafe Wise API path.");
		this.name = "UnsafePathError";
	}
}

export function wiseId(value: string, name: string): string {
	if (!ID.test(value)) throw new PathParamError(name);
	return value;
}

/**
 * Validate a caller-supplied path parameter and encode it.
 * The allowed alphabet is unchanged by encodeURIComponent; encoding still runs so a
 * future relaxation of the pattern cannot splice raw bytes into the path.
 */
export function pathSegment(value: string, name: string): string {
	if (!SEGMENT.test(value)) throw new PathParamError(name);
	return encodeURIComponent(value);
}

export function assertSafePath(path: string): void {
	if (!path.startsWith("/")) throw new UnsafePathError();
	const segments = path.slice(1).split("/");
	if (segments.length === 0 || segments.some((segment) => segment !== "statement.json" && !SEGMENT.test(segment))) {
		throw new UnsafePathError();
	}
}

/** Build an absolute API path from static segments and validated caller parameters. */
export function apiPath(parts: Array<string | { readonly value: string; readonly name: string }>): string {
	const encoded = parts.map((part) => {
		if (typeof part === "string") {
			if (part !== "statement.json" && !SEGMENT.test(part)) throw new UnsafePathError();
			return part;
		}
		return pathSegment(part.value, part.name);
	});
	const path = `/${encoded.join("/")}`;
	assertSafePath(path);
	return path;
}
