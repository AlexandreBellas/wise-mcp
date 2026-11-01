import { describe, expect, it, vi } from "vitest";
import { httpFetch, isAllowedOutbound } from "../src/http-fetch.js";
import { loadConfig } from "../src/config.js";

describe("Wise outbound allowlist", () => {
	it("allows versioned GETs and the legacy account-details GET on Wise hosts", () => {
		expect(isAllowedOutbound(new URL("https://api.wise.com/2026Q4/profiles"), "GET")).toBe(true);
		expect(isAllowedOutbound(new URL("https://api.wise-sandbox.com/2026Q4/rates?source=EUR"), "GET")).toBe(true);
		expect(isAllowedOutbound(new URL("https://api.wise.com/2026Q4/profiles/7/balance-statements/8/statement.json"), "GET")).toBe(true);
		expect(isAllowedOutbound(new URL("https://api.wise.com/v1/profiles/7/account-details"), "GET")).toBe(true);
	});

	it("rejects other verbs, hosts, and paths", () => {
		expect(isAllowedOutbound(new URL("https://api.wise.com/2026Q4/transfers"), "POST")).toBe(false);
		expect(isAllowedOutbound(new URL("https://api.wise.com/2026Q4/transfers/9/cancel"), "PUT")).toBe(false);
		expect(isAllowedOutbound(new URL("https://evil.example/2026Q4/profiles"), "GET")).toBe(false);
		expect(isAllowedOutbound(new URL("https://api.wise.com/v1/transfers"), "GET")).toBe(false);
		const escaped = new URL("https://api.wise.com/2026Q4/profiles/../admin");
		expect(escaped.origin).toBe("https://api.wise.com");
		expect(escaped.pathname).toBe("/2026Q4/admin");
		expect(isAllowedOutbound(new URL("https://user:pass@api.wise.com/2026Q4/profiles"), "GET")).toBe(false);
	});

	it("does not call fetch for a refused request", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		await expect(httpFetch("https://api.wise.com/v1/transfers", { method: "GET" })).rejects.toThrow(
			"Refusing to request outside the Wise API.",
		);
		expect(fetchMock).not.toHaveBeenCalled();
		vi.unstubAllGlobals();
	});
});

describe("WISE_API_BASE", () => {
	it("defaults to production and accepts the sandbox host", () => {
		expect(loadConfig({}).baseUrl).toBe("https://api.wise.com");
		expect(loadConfig({}).apiVersion).toBe("2026Q4");
		expect(loadConfig({ WISE_API_BASE: "https://api.wise-sandbox.com/" }).baseUrl).toBe("https://api.wise-sandbox.com");
		expect(loadConfig({ WISE_API_BASE: "https://api.wise.com/v1" }).configError).toContain("no path");
		expect(loadConfig({ WISE_API_VERSION: "latest" }).configError).toContain("2026Q4");
	});
});
