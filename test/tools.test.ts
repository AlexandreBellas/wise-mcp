import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearAuthLockoutCache } from "../src/auth-gate.js";
import { SCA_NOT_CONFIGURED_MESSAGE, SCA_REJECTED_MESSAGE } from "../src/sca.js";
import { handleRequest } from "../src/http.js";
import { invocationSensitiveFetch, jsonRpc, MCP_TOKEN, mcpRequest, testEnv, toolText, WISE_TOKEN, type FetchCall } from "./helpers.js";
import { rsaPkcs8Pem, signatureVerifies } from "./sca-key.js";

const READ_TOOLS = [
	"wise_status",
	"wise_list_profiles",
	"wise_list_balances",
	"wise_get_balance",
	"wise_get_balance_statement",
	"wise_list_activities",
	"wise_list_transfers",
	"wise_get_transfer",
	"wise_get_exchange_rates",
	"wise_list_account_details",
	"wise_get_account_details",
];

const WRITE_TOOLS = [
	"wise_create_transfer",
	"wise_fund_transfer",
	"wise_cancel_transfer",
	"wise_create_quote",
	"wise_create_recipient",
	"wise_create_balance",
];

afterEach(() => {
	clearAuthLockoutCache();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

function fakePem(label: string): string {
	return `-----BEGIN ${label}-----\nMIIB\n-----END ${label}-----`;
}

function sourceFiles(dir: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) files.push(...sourceFiles(path));
		else if (path.endsWith(".ts")) files.push(path);
	}
	return files;
}

async function callMcp(body: unknown, env = testEnv()): Promise<unknown> {
	const response = await handleRequest(mcpRequest({ token: MCP_TOKEN, body }), env);
	expect(response.status).toBe(200);
	return response.json();
}

describe("read-only tool registry", () => {
	it("registers every read tool and no write tool", async () => {
		const listed = (await callMcp(jsonRpc("tools/list", 1))) as {
			result?: { tools?: { name: string; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }[] };
		};
		const tools = listed.result?.tools ?? [];
		const names = tools.map((tool) => tool.name).sort();
		expect(names).toEqual([...READ_TOOLS].sort());
		for (const name of WRITE_TOOLS) expect(names).not.toContain(name);
		for (const tool of tools) {
			expect(tool.annotations?.readOnlyHint, tool.name).toBe(true);
			expect(tool.annotations?.destructiveHint, tool.name).toBe(false);
		}
	});

	it("has no write verb and does not read process.env", () => {
		const files = sourceFiles("src");
		for (const file of files) {
			const text = readFileSync(file, "utf8");
			expect(text, file).not.toContain("process.env");
			expect(text, file).not.toContain("StdioServerTransport");
			expect(text, file).not.toMatch(/method:\s*["'](?:POST|PUT|PATCH|DELETE)["']/);
			for (const name of WRITE_TOOLS) expect(text, file).not.toContain(name);
		}
	});

	it("refuses a path parameter that would escape the API and does not fetch it", async () => {
		const calls: string[] = [];
		vi.stubGlobal(
			"fetch",
			invocationSensitiveFetch((input) => {
				calls.push(String(input));
				return Response.json({});
			}),
		);
		const response = (await callMcp(
			jsonRpc("tools/call", 2, { name: "wise_get_transfer", arguments: { transferId: "../admin" } }),
		)) as { result?: { isError?: boolean } };
		expect(response.result?.isError).toBe(true);
		expect(toolText(response)).toContain("transferId is not a valid path parameter");
		expect(calls).toEqual([]);
	});

	it("lists profiles with a GET and drops contact fields", async () => {
		const calls: FetchCall[] = [];
		vi.stubGlobal(
			"fetch",
			invocationSensitiveFetch(async (input, init) => {
				const headers = new Headers(init?.headers);
				calls.push({ url: String(input), method: init?.method ?? "GET", authorization: headers.get("authorization") });
				return Response.json([
					{
						id: 42,
						type: "PERSONAL",
						fullName: "Ada Lovelace",
						currentState: "VISIBLE",
						email: "ada@example.com",
						phoneNumber: "+441234",
					},
				]);
			}),
		);
		const response = await callMcp(jsonRpc("tools/call", 3, { name: "wise_list_profiles", arguments: {} }));
		expect(toolText(response)).toContain("Ada Lovelace");
		expect(toolText(response)).not.toContain("ada@example.com");
		expect(toolText(response)).not.toContain(WISE_TOKEN);
		expect(calls).toEqual([
			{
				url: "https://api.wise.com/2026Q4/profiles",
				method: "GET",
				authorization: `Bearer ${WISE_TOKEN}`,
			},
		]);
	});

	it("sends statement filters and returns a normalized transaction", async () => {
		const calls: string[] = [];
		vi.stubGlobal(
			"fetch",
			invocationSensitiveFetch(async (input) => {
				calls.push(String(input));
				return Response.json({
					accountHolder: { firstName: "Hidden", address: { addressFirstLine: "Secret Street" } },
					query: { currency: "EUR", intervalStart: "2026-01-01T00:00:00Z", intervalEnd: "2026-01-31T00:00:00Z" },
					endOfStatementBalance: { value: 10, currency: "EUR" },
					transactions: [
						{
							type: "CREDIT",
							date: "2026-01-15T00:00:00Z",
							amount: { value: 10, currency: "EUR" },
							totalFees: { value: 0, currency: "EUR" },
							details: { type: "DEPOSIT", senderName: "Ada Lovelace", description: "Top up" },
							runningBalance: { value: 10, currency: "EUR" },
							referenceNumber: "DEP-1",
						},
					],
				});
			}),
		);
		const response = await callMcp(
			jsonRpc("tools/call", 4, {
				name: "wise_get_balance_statement",
				arguments: {
					profileId: "7",
					balanceId: "8",
					currency: "eur",
					intervalStart: "2026-01-01T00:00:00Z",
					intervalEnd: "2026-01-31T00:00:00Z",
				},
			}),
		);
		const text = toolText(response);
		expect(text).toContain('"direction": "in"');
		expect(text).toContain("Ada Lovelace");
		expect(text).not.toContain("Secret Street");
		expect(text).not.toContain("Hidden");
		const url = new URL(calls[0] ?? "");
		expect(url.origin + url.pathname).toBe("https://api.wise.com/2026Q4/profiles/7/balance-statements/8/statement.json");
		expect(url.searchParams.get("currency")).toBe("EUR");
		expect(url.searchParams.get("type")).toBe("COMPACT");
	});

	it("returns a clear SCA error and does not log the challenge or the token", async () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const ott = "be2f6579-9426-480b-9cb7-d8f1116cc8b9";
		let calls = 0;
		vi.stubGlobal(
			"fetch",
			invocationSensitiveFetch(async () => {
				calls += 1;
				return new Response(
					JSON.stringify({
						message: "This request requires Strong Customer Authentication.",
						accountHolder: "Private Person",
						token: WISE_TOKEN,
					}),
					{ status: 403, headers: { "x-2fa-approval": ott, "content-type": "application/json" } },
				);
			}),
		);
		const response = await callMcp(
			jsonRpc("tools/call", 5, {
				name: "wise_get_balance_statement",
				arguments: {
					profileId: "7",
					balanceId: "8",
					currency: "EUR",
					intervalStart: "2026-01-01T00:00:00Z",
					intervalEnd: "2026-02-01T00:00:00Z",
				},
			}),
		);
		const text = toolText(response);
		expect(text).toBe(SCA_NOT_CONFIGURED_MESSAGE);
		expect(text).toContain("WISE_SCA_PRIVATE_KEY");
		expect(text).toContain("BEGIN PRIVATE KEY");
		expect(calls).toBe(1);
		expect(text).not.toContain(ott);
		expect(text).not.toContain(WISE_TOKEN);
		expect(text).not.toContain("Private Person");
		const logged = errors.mock.calls.map((args) => args.join(" ")).join("\n");
		expect(logged).not.toContain(ott);
		expect(logged).not.toContain(WISE_TOKEN);
		expect(logged).not.toContain("Private Person");
	});

	it("honours Wise Retry-After and does not call Wise again until it elapses", async () => {
		let calls = 0;
		vi.stubGlobal(
			"fetch",
			invocationSensitiveFetch(async () => {
				calls += 1;
				return new Response(JSON.stringify({ message: "Too many requests", echo: WISE_TOKEN }), {
					status: 429,
					headers: { "retry-after": "30", "content-type": "application/json" },
				});
			}),
		);
		const env = testEnv();
		const first = await callMcp(jsonRpc("tools/call", 6, { name: "wise_list_profiles", arguments: {} }), env);
		const second = await callMcp(jsonRpc("tools/call", 7, { name: "wise_list_profiles", arguments: {} }), env);
		expect(toolText(first)).toContain("HTTP 429");
		expect(toolText(first)).toContain("Retry after 30 seconds");
		expect(toolText(first)).not.toContain(WISE_TOKEN);
		expect(toolText(second)).toContain("Wise api limit reached");
		expect(calls).toBe(1);
	});

	it("uses the sandbox host when WISE_API_BASE points there", async () => {
		const calls: string[] = [];
		vi.stubGlobal(
			"fetch",
			invocationSensitiveFetch(async (input) => {
				calls.push(String(input));
				return Response.json([]);
			}),
		);
		await callMcp(jsonRpc("tools/call", 8, { name: "wise_get_exchange_rates", arguments: { source: "EUR", target: "USD" } }), testEnv({ WISE_API_BASE: "https://api.wise-sandbox.com" }));
		expect(calls[0]).toBe("https://api.wise-sandbox.com/2026Q4/rates?source=EUR&target=USD");
	});

	it("refuses a Wise host that is not production or sandbox and does not fetch", async () => {
		const calls: string[] = [];
		vi.stubGlobal(
			"fetch",
			invocationSensitiveFetch((input) => {
				calls.push(String(input));
				return Response.json([]);
			}),
		);
		const response = await callMcp(
			jsonRpc("tools/call", 9, { name: "wise_list_profiles", arguments: {} }),
			testEnv({ WISE_API_BASE: "https://evil.example" }),
		);
		expect(toolText(response)).toContain("WISE_API_BASE must be https://api.wise.com or https://api.wise-sandbox.com.");
		expect(calls).toEqual([]);
	});

	it("requests legacy account details and versioned transfer filters", async () => {
		const calls: string[] = [];
		vi.stubGlobal(
			"fetch",
			invocationSensitiveFetch(async (input) => {
				calls.push(String(input));
				const url = String(input);
				if (url.includes("/v1/profiles/")) {
					return Response.json([
						{
							id: 5,
							currency: { code: "GBP" },
							status: "ACTIVE",
							receiveOptions: [{ details: [{ type: "ACCOUNT_NUMBER", title: "Account number", body: "00000001", hidden: false }] }],
						},
					]);
				}
				return Response.json([
					{
						id: 9,
						status: "outgoing_payment_sent",
						created: "2026-03-01T00:00:00Z",
						sourceValue: 20,
						sourceCurrency: "EUR",
						targetValue: 17,
						targetCurrency: "GBP",
						rate: 0.85,
						targetAccount: 3,
						details: { reference: "rent" },
					},
				]);
			}),
		);
		const details = await callMcp(
			jsonRpc("tools/call", 10, { name: "wise_list_account_details", arguments: { profileId: "15", currency: "GBP" } }),
		);
		const transfers = await callMcp(
			jsonRpc("tools/call", 11, {
				name: "wise_list_transfers",
				arguments: { profileId: "15", status: "outgoing_payment_sent", sourceCurrency: "EUR", limit: 10, offset: 0 },
			}),
		);
		expect(toolText(details)).toContain("00000001");
		expect(calls[0]).toBe("https://api.wise.com/v1/profiles/15/account-details?currency=GBP");
		expect(toolText(transfers)).toContain('"reference": "rent"');
		const transferUrl = new URL(calls[1] ?? "");
		expect(transferUrl.pathname).toBe("/2026Q4/transfers");
		expect(transferUrl.searchParams.get("profile")).toBe("15");
		expect(transferUrl.searchParams.get("status")).toBe("outgoing_payment_sent");
		expect(transferUrl.searchParams.get("limit")).toBe("10");
	});

	it("signs an SCA challenge once and retries the same GET", async () => {
		const keys = rsaPkcs8Pem();
		const ott = "be2f6579-9426-480b-9cb7-d8f1116cc8b9";
		const seen: { url: string; method: string; approval: string | null; signature: string | null }[] = [];
		vi.stubGlobal(
			"fetch",
			invocationSensitiveFetch(async (input, init) => {
				const headers = new Headers(init?.headers);
				seen.push({
					url: String(input),
					method: init?.method ?? "GET",
					approval: headers.get("x-2fa-approval"),
					signature: headers.get("x-signature"),
				});
				if (seen.length === 1) {
					return new Response(JSON.stringify({ message: "strong customer authentication", accountHolder: "Private Person" }), {
						status: 403,
						headers: { "x-2fa-approval": ott, "x-2fa-approval-result": "REJECTED" },
					});
				}
				return Response.json({
					query: { currency: "EUR", intervalStart: "2026-01-01T00:00:00Z", intervalEnd: "2026-02-01T00:00:00Z" },
					transactions: [],
				});
			}),
		);
		const env = testEnv({ WISE_SCA_PRIVATE_KEY: keys.privatePem });
		const response = await callMcp(
			jsonRpc("tools/call", 12, {
				name: "wise_get_balance_statement",
				arguments: {
					profileId: "7",
					balanceId: "8",
					currency: "EUR",
					intervalStart: "2026-01-01T00:00:00Z",
					intervalEnd: "2026-02-01T00:00:00Z",
				},
			}),
			env,
		);
		const text = toolText(response);
		expect(text).toContain('"transactions": []');
		expect(text).not.toContain(ott);
		expect(text).not.toContain("BEGIN PRIVATE KEY");
		expect(text).not.toContain("Private Person");
		expect(seen).toHaveLength(2);
		expect(seen[0]?.method).toBe("GET");
		expect(seen[1]?.method).toBe("GET");
		expect(seen[0]?.url).toBe(seen[1]?.url);
		expect(seen[0]?.approval).toBeNull();
		expect(seen[0]?.signature).toBeNull();
		expect(seen[1]?.approval).toBe(ott);
		expect(seen[1]?.signature).toBeTruthy();
		expect(signatureVerifies(keys.publicPem, ott, seen[1]?.signature ?? "")).toBe(true);

		const status = await callMcp(jsonRpc("tools/call", 13, { name: "wise_status", arguments: {} }), env);
		expect(toolText(status)).toContain('"scaSigningConfigured": true');
		expect(toolText(status)).not.toContain("BEGIN PRIVATE KEY");
	});

	it("does not retry when the signed challenge is rejected", async () => {
		const keys = rsaPkcs8Pem();
		const ott = "be2f6579-9426-480b-9cb7-d8f1116cc8b9";
		let calls = 0;
		vi.stubGlobal(
			"fetch",
			invocationSensitiveFetch(async () => {
				calls += 1;
				return new Response("{}", { status: 403, headers: { "x-2fa-approval": ott } });
			}),
		);
		const response = await callMcp(
			jsonRpc("tools/call", 14, { name: "wise_get_transfer", arguments: { transferId: "1564145034" } }),
			testEnv({ WISE_SCA_PRIVATE_KEY: keys.privatePem }),
		);
		expect(calls).toBe(2);
		expect(toolText(response)).toBe(SCA_REJECTED_MESSAGE);
		expect(toolText(response)).not.toContain(ott);
		expect(toolText(response)).not.toContain("BEGIN PRIVATE KEY");
	});

	it("does not sign a 403 that is not an SCA challenge", async () => {
		const keys = rsaPkcs8Pem();
		let calls = 0;
		vi.stubGlobal(
			"fetch",
			invocationSensitiveFetch(async () => {
				calls += 1;
				return Response.json({ error: "forbidden" }, { status: 403 });
			}),
		);
		const response = await callMcp(
			jsonRpc("tools/call", 15, { name: "wise_get_transfer", arguments: { transferId: "1564145034" } }),
			testEnv({ WISE_SCA_PRIVATE_KEY: keys.privatePem }),
		);
		expect(calls).toBe(1);
		expect(toolText(response)).toContain("HTTP 403");
		expect(toolText(response)).not.toContain("x-2fa-approval");
	});

	it("does not call Wise again when the SCA key is not PKCS#8", async () => {
		let calls = 0;
		vi.stubGlobal(
			"fetch",
			invocationSensitiveFetch(async () => {
				calls += 1;
				return new Response("{}", {
					status: 403,
					headers: { "x-2fa-approval": "be2f6579-9426-480b-9cb7-d8f1116cc8b9" },
				});
			}),
		);
		const response = await callMcp(
			jsonRpc("tools/call", 16, { name: "wise_get_transfer", arguments: { transferId: "1564145034" } }),
			testEnv({ WISE_SCA_PRIVATE_KEY: fakePem("RSA PRIVATE KEY") }),
		);
		expect(calls).toBe(1);
		expect(toolText(response)).toContain("PKCS#1");
		expect(toolText(response)).not.toContain("MIIB");
		const status = await callMcp(
			jsonRpc("tools/call", 17, { name: "wise_status", arguments: {} }),
			testEnv({ WISE_SCA_PRIVATE_KEY: fakePem("RSA PRIVATE KEY") }),
		);
		expect(toolText(status)).toContain('"scaSigningConfigured": false');
		expect(toolText(status)).toContain("PKCS#1");
		expect(toolText(status)).not.toContain("MIIB");
	});

	it("reports SCA signing as not configured", async () => {
		const response = await callMcp(jsonRpc("tools/call", 18, { name: "wise_status", arguments: {} }));
		expect(toolText(response)).toContain('"scaSigningConfigured": false');
		expect(toolText(response)).toContain('"scaConfigError": null');
		expect(toolText(response)).not.toContain(WISE_TOKEN);
	});
});
