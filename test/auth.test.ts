import { afterEach, describe, expect, it, vi } from "vitest";
import { authorizeMcpRequest, clearAuthLockoutCache } from "../src/auth-gate.js";
import { handleRequest } from "../src/http.js";
import { MCP_TOKEN, mcpRequest, testEnv } from "./helpers.js";

afterEach(() => {
	clearAuthLockoutCache();
	vi.restoreAllMocks();
});

describe("endpoint auth", () => {
	it("returns a JSON-RPC 401 when the bearer token is missing", async () => {
		let called = false;
		const response = await handleRequest(mcpRequest({ token: null }), testEnv(), async () => {
			called = true;
			return new Response("mcp");
		});
		expect(response.status).toBe(401);
		expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");
		await expect(response.json()).resolves.toEqual({
			jsonrpc: "2.0",
			id: null,
			error: { code: -32001, message: "Unauthorized" },
		});
		expect(called).toBe(false);
	});

	it("returns a JSON-RPC 401 for the wrong bearer token and does not echo it", async () => {
		const wrong = "wrong-mcp-token-value";
		const response = await authorizeMcpRequest(mcpRequest({ token: wrong }), testEnv());
		expect(response?.status).toBe(401);
		const text = await response?.text();
		expect(text).not.toContain(wrong);
		expect(text).not.toContain(MCP_TOKEN);
		expect(JSON.parse(text ?? "")).toMatchObject({ error: { message: "Unauthorized" } });
	});

	it("fails closed when MCP_AUTH_TOKEN is not configured", async () => {
		const response = await handleRequest(mcpRequest({ token: MCP_TOKEN }), testEnv({ MCP_AUTH_TOKEN: "  " }), async () => {
			throw new Error("handler should not run");
		});
		expect(response.status).toBe(503);
		await expect(response.json()).resolves.toMatchObject({
			error: { message: "MCP authentication is not configured." },
		});
	});

	it("allows the request when the bearer token matches", async () => {
		const response = await handleRequest(mcpRequest({ token: MCP_TOKEN }), testEnv(), async () => new Response("mcp-ok"));
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("mcp-ok");
	});

	it("locks the client IP after repeated failures and keeps a later correct token out", async () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const env = testEnv({ AUTH_FAILURE_LIMIT: "2", AUTH_LOCKOUT_SECONDS: "60" });
		let called = false;
		const mcp = async () => {
			called = true;
			return new Response("mcp");
		};

		const missing = await handleRequest(mcpRequest({ token: null }), env, mcp);
		const wrong = await handleRequest(mcpRequest({ token: "another-wrong-token" }), env, mcp);
		const locked = await handleRequest(mcpRequest({ token: MCP_TOKEN }), env, mcp);

		expect(missing.status).toBe(401);
		expect(wrong.status).toBe(429);
		expect(wrong.headers.get("retry-after")).toBe("60");
		await expect(wrong.json()).resolves.toMatchObject({
			jsonrpc: "2.0",
			error: { code: -32029, message: "Too many failed authentication attempts. Try again later." },
		});
		expect(locked.status).toBe(429);
		expect(called).toBe(false);

		const otherIp = await handleRequest(mcpRequest({ token: MCP_TOKEN, ip: "203.0.113.99" }), env, mcp);
		expect(otherIp.status).toBe(200);
		expect(errors.mock.calls.map((args) => args.join(" ")).join("\n")).not.toContain(MCP_TOKEN);
	});

	it("returns 503 when the limiter is unavailable", async () => {
		const env = testEnv({
			AUTH_RATE_LIMIT: {
				getByName() {
					return {
						check() {
							throw new Error("do unavailable");
						},
						recordFailure() {
							throw new Error("do unavailable");
						},
					};
				},
			},
		});
		const response = await authorizeMcpRequest(mcpRequest({ token: MCP_TOKEN }), env);
		expect(response?.status).toBe(503);
		await expect(response?.json()).resolves.toMatchObject({
			error: { message: "Authentication protection is unavailable." },
		});
	});

	it("serves health without a token", async () => {
		const response = await handleRequest(
			new Request("https://wise-mcp.example.workers.dev/health"),
			testEnv({ MCP_AUTH_TOKEN: "" }),
			async () => {
				throw new Error("handler should not run");
			},
		);
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({ status: "ok", service: "wise-mcp" });
	});
});
