/**
 * Strong Customer Authentication for a Wise personal API token.
 *
 * Wise returns HTTP 403 with `x-2fa-approval` set to a one-time token.
 * The client signs that token with SHA-256 RSA (RSASSA-PKCS1-v1_5), which is
 * the same operation as `openssl sha256 -sign`, and retries the same GET with
 * `x-2fa-approval` and `X-Signature`. The public key is uploaded in Wise.
 * WebCrypto imports PKCS#8 only, so the Worker secret must be that PEM.
 */

export const SCA_NOT_CONFIGURED_MESSAGE =
	"Wise requires Strong Customer Authentication for this read (HTTP 403, x-2fa-approval). Signing is not configured. Set the Worker secret WISE_SCA_PRIVATE_KEY to an unencrypted PKCS#8 PEM (-----BEGIN PRIVATE KEY----- / -----END PRIVATE KEY-----), RSA 2048 bits or more. Upload the matching public key in Wise at Settings > API tokens > Manage public keys. This server does not return the one-time token.";

export const SCA_KEY_INVALID_MESSAGE =
	"WISE_SCA_PRIVATE_KEY is set but cannot sign. It must be an unencrypted PKCS#8 PEM RSA private key of at least 2048 bits, including the BEGIN PRIVATE KEY and END PRIVATE KEY lines. A PKCS#1 key (BEGIN RSA PRIVATE KEY) must be converted with: openssl pkcs8 -topk8 -nocrypt -in private.pem -out private-pkcs8.pem";

export const SCA_REJECTED_MESSAGE =
	"Wise still returned HTTP 403 after this server signed the x-2fa-approval challenge. The public key in Wise (Settings > API tokens > Manage public keys) must match WISE_SCA_PRIVATE_KEY. The one-time token was not reused and is not returned.";

export const SCA_TOKEN_UNUSABLE_MESSAGE =
	"Wise returned an SCA challenge whose x-2fa-approval token could not be signed safely. The token is not returned.";

export const SCA_NO_TOKEN_MESSAGE =
	"Wise returned HTTP 403 for Strong Customer Authentication but did not send an x-2fa-approval one-time token, so there is nothing to sign. When Wise does send that header, set WISE_SCA_PRIVATE_KEY to an unencrypted PKCS#8 PEM (-----BEGIN PRIVATE KEY-----) and upload the matching public key under Wise Settings > API tokens > Manage public keys.";

const RSA_OID = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01] as const;
const MAX_PEM_BYTES = 5 * 1024;

export class ScaConfigError extends Error {
	readonly keyPresent: boolean;

	constructor(message: string, keyPresent: boolean) {
		super(message);
		this.name = "ScaConfigError";
		this.keyPresent = keyPresent;
	}
}

export type ScaStatus = {
	scaSigningConfigured: boolean;
	scaConfigError: string | null;
};

export async function scaStatus(pem: string | null): Promise<ScaStatus> {
	if (pem === null || pem.length === 0) return { scaSigningConfigured: false, scaConfigError: null };
	try {
		await importScaKey(pem);
		return { scaSigningConfigured: true, scaConfigError: null };
	} catch (error) {
		const message = error instanceof ScaConfigError ? error.message : SCA_KEY_INVALID_MESSAGE;
		return { scaSigningConfigured: false, scaConfigError: message };
	}
}

export async function signScaToken(pem: string | null, token: string): Promise<string> {
	if (pem === null || pem.length === 0) throw new ScaConfigError(SCA_NOT_CONFIGURED_MESSAGE, false);
	const key = await importScaKey(pem);
	const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(token));
	return bytesToBase64(new Uint8Array(signature));
}

async function importScaKey(pem: string): Promise<CryptoKey> {
	if (new TextEncoder().encode(pem).byteLength > MAX_PEM_BYTES) {
		throw new ScaConfigError(
			"WISE_SCA_PRIVATE_KEY is larger than the 5 KB Worker secret limit. Use a 2048-bit RSA key.",
			true,
		);
	}
	const der = pkcs8Der(pem);
	assertRsaAtLeast2048(der);
	try {
		return await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
	} catch {
		throw new ScaConfigError(SCA_KEY_INVALID_MESSAGE, true);
	}
}

function pkcs8Der(pem: string): Uint8Array {
	const normalized = pem.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
	if (normalized.includes("BEGIN ENCRYPTED PRIVATE KEY") || /Proc-Type:\s*4,ENCRYPTED/.test(normalized)) {
		throw new ScaConfigError(
			"WISE_SCA_PRIVATE_KEY is encrypted. The Worker needs an unencrypted PKCS#8 PEM. Convert with: openssl pkcs8 -topk8 -nocrypt -in private.pem -out private-pkcs8.pem",
			true,
		);
	}
	if (normalized.includes("BEGIN RSA PRIVATE KEY")) {
		throw new ScaConfigError(
			"WISE_SCA_PRIVATE_KEY is PKCS#1 (BEGIN RSA PRIVATE KEY). Convert it with: openssl pkcs8 -topk8 -nocrypt -in private.pem -out private-pkcs8.pem",
			true,
		);
	}
	if (normalized.includes("BEGIN PUBLIC KEY") && !normalized.includes("BEGIN PRIVATE KEY")) {
		throw new ScaConfigError(
			"WISE_SCA_PRIVATE_KEY is a public key. Set the PKCS#8 private key here. Upload only the public key to Wise.",
			true,
		);
	}
	const match = /-----BEGIN PRIVATE KEY-----\s*([A-Za-z0-9+/=\s]+?)\s*-----END PRIVATE KEY-----/.exec(normalized);
	const body = match?.[1]?.replace(/\s+/g, "") ?? "";
	if (body.length === 0) throw new ScaConfigError(SCA_KEY_INVALID_MESSAGE, true);
	return base64ToBytes(body);
}

function assertRsaAtLeast2048(der: Uint8Array): void {
	let info: Uint8Array;
	try {
		const outer = new DerReader(der);
		info = outer.readTag(0x30);
		const body = new DerReader(info);
		body.readTag(0x02);
		const algorithm = body.readTag(0x30);
		const oid = new DerReader(algorithm).readTag(0x06);
		if (oid.length !== RSA_OID.length || RSA_OID.some((byte, index) => oid[index] !== byte)) {
			throw new ScaConfigError("WISE_SCA_PRIVATE_KEY must be an RSA key. Wise verifies SHA-256 with RSA.", true);
		}
		const privateKey = body.readTag(0x04);
		const rsa = new DerReader(new DerReader(privateKey).readTag(0x30));
		rsa.readTag(0x02);
		const modulus = rsa.readTag(0x02);
		const significant = modulus[0] === 0x00 ? modulus.length - 1 : modulus.length;
		if (significant < 256) {
			throw new ScaConfigError(
				"WISE_SCA_PRIVATE_KEY is shorter than 2048 bits. Wise requires RSA of at least 2048 bits.",
				true,
			);
		}
	} catch (error) {
		if (error instanceof ScaConfigError) throw error;
		throw new ScaConfigError(SCA_KEY_INVALID_MESSAGE, true);
	}
}

class DerReader {
	private offset = 0;

	constructor(private bytes: Uint8Array) {}

	readTag(expected: number): Uint8Array {
		if (this.bytes[this.offset] !== expected) throw new Error("der");
		this.offset += 1;
		const length = this.readLength();
		const end = this.offset + length;
		if (length < 0 || end > this.bytes.length) throw new Error("der");
		const slice = this.bytes.subarray(this.offset, end);
		this.offset = end;
		return slice;
	}

	private readLength(): number {
		const first = this.bytes[this.offset];
		if (first === undefined) throw new Error("der");
		this.offset += 1;
		if (first < 0x80) return first;
		const count = first & 0x7f;
		if (count === 0 || count > 3) throw new Error("der");
		let length = 0;
		for (let index = 0; index < count; index += 1) {
			const byte = this.bytes[this.offset];
			if (byte === undefined) throw new Error("der");
			this.offset += 1;
			length = (length << 8) | byte;
		}
		return length;
	}
}

function base64ToBytes(value: string): Uint8Array {
	if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
		throw new ScaConfigError(SCA_KEY_INVALID_MESSAGE, true);
	}
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
	return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index] ?? 0);
	return btoa(binary);
}
