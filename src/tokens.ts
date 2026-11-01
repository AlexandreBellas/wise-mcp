type SubtleWithTimingSafeEqual = SubtleCrypto & {
	timingSafeEqual?: (a: BufferSource, b: BufferSource) => boolean;
};

/**
 * Compare two secrets without leaking the expected value through a byte-by-byte scan.
 * Both sides are hashed to a fixed length first so a length mismatch is not a shortcut.
 * Workers provides crypto.subtle.timingSafeEqual. Other runtimes use a fixed-length XOR.
 */
export async function tokensMatch(provided: string, expected: string): Promise<boolean> {
	const encoder = new TextEncoder();
	const [providedHash, expectedHash] = await Promise.all([
		crypto.subtle.digest("SHA-256", encoder.encode(provided)),
		crypto.subtle.digest("SHA-256", encoder.encode(expected)),
	]);
	const subtle = crypto.subtle as SubtleWithTimingSafeEqual;
	if (typeof subtle.timingSafeEqual === "function") {
		return subtle.timingSafeEqual(providedHash, expectedHash);
	}
	const left = new Uint8Array(providedHash);
	const right = new Uint8Array(expectedHash);
	let diff = 0;
	for (let index = 0; index < left.length; index += 1) {
		diff |= left[index]! ^ right[index]!;
	}
	return diff === 0;
}
