import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";

export function rsaPkcs8Pem(modulusLength = 2048): { privatePem: string; publicPem: string } {
	const { privateKey, publicKey } = generateKeyPairSync("rsa", {
		modulusLength,
		publicKeyEncoding: { type: "spki", format: "pem" },
		privateKeyEncoding: { type: "pkcs8", format: "pem" },
	});
	return { privatePem: privateKey, publicPem: publicKey };
}

export function signatureVerifies(publicPem: string, token: string, signature: string): boolean {
	return verify("RSA-SHA256", Buffer.from(token, "utf8"), createPublicKey(publicPem), Buffer.from(signature, "base64"));
}
