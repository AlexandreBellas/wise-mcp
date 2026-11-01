import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { scaStatus, signScaToken } from "../src/sca.js";
import { rsaPkcs8Pem, signatureVerifies } from "./sca-key.js";

const OTT = "be2f6579-9426-480b-9cb7-d8f1116cc8b9";

describe("SCA private key", () => {
	it("signs the one-time token with SHA-256 RSA in PKCS#8 PEM form", async () => {
		const keys = rsaPkcs8Pem();
		expect(keys.privatePem).toContain("-----BEGIN PRIVATE KEY-----");
		expect(keys.privatePem).not.toContain("BEGIN RSA PRIVATE KEY");
		const signature = await signScaToken(keys.privatePem, OTT);
		expect(signatureVerifies(keys.publicPem, OTT, signature)).toBe(true);
		expect(opensslVerifies(keys.publicPem, OTT, signature)).toBe(true);
		const escaped = keys.privatePem.replace(/\n/g, "\\n");
		expect(await signScaToken(escaped, OTT)).not.toBe("");
		expect(signatureVerifies(keys.publicPem, OTT, await signScaToken(escaped, OTT))).toBe(true);
		const status = await scaStatus(keys.privatePem);
		expect(status).toEqual({ scaSigningConfigured: true, scaConfigError: null });
		expect(JSON.stringify(status)).not.toContain("BEGIN PRIVATE KEY");
	});

	it("rejects PKCS#1, encrypted, public, and short keys without echoing the secret", async () => {
		const pkcs1 = pem("RSA PRIVATE KEY", "MIIB");
		await expect(signScaToken(pkcs1, OTT)).rejects.toThrow(/pkcs8 -topk8 -nocrypt/);
		await expect(signScaToken(pem("ENCRYPTED PRIVATE KEY", "YQ=="), OTT)).rejects.toThrow(/unencrypted/);
		await expect(signScaToken(pem("PUBLIC KEY", "MIIB"), OTT)).rejects.toThrow(/public key/);
		await expect(scaStatus("not a key")).resolves.toMatchObject({ scaSigningConfigured: false });
		const broken = await scaStatus(pkcs1);
		expect(broken.scaSigningConfigured).toBe(false);
		expect(broken.scaConfigError).toContain("PKCS#1");
		expect(broken.scaConfigError).not.toContain("MIIB");
		expect(loadConfig({ WISE_SCA_PRIVATE_KEY: "  " }).scaPrivateKey).toBeNull();
		expect(loadConfig({ WISE_SCA_PRIVATE_KEY: pkcs1 }).configError).toBeNull();

		let short: string;
		try {
			short = rsaPkcs8Pem(1024).privatePem;
		} catch {
			return;
		}
		await expect(signScaToken(short, OTT)).rejects.toThrow(/2048/);
	});

	it("reports signing as not configured when the secret is absent", async () => {
		expect(await scaStatus(null)).toEqual({ scaSigningConfigured: false, scaConfigError: null });
		await expect(signScaToken(null, OTT)).rejects.toThrow(/WISE_SCA_PRIVATE_KEY/);
	});
});

function pem(label: string, body: string): string {
	return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----`;
}

function opensslVerifies(publicPem: string, token: string, signature: string): boolean {
	const dir = mkdtempSync(join(tmpdir(), "wise-sca-"));
	try {
		writeFileSync(join(dir, "public.pem"), publicPem);
		writeFileSync(join(dir, "token.txt"), token);
		writeFileSync(join(dir, "sig.b64"), signature);
		execFileSync("openssl", ["base64", "-d", "-A", "-in", "sig.b64", "-out", "sig.bin"], { cwd: dir });
		execFileSync("openssl", ["dgst", "-sha256", "-verify", "public.pem", "-signature", "sig.bin", "token.txt"], { cwd: dir });
		return true;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
