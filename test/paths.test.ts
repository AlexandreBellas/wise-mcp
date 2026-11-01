import { describe, expect, it } from "vitest";
import { apiPath, PathParamError, wiseId } from "../src/paths.js";

describe("path parameters", () => {
	it("builds a statement path from decimal ids", () => {
		expect(
			apiPath(["profiles", { value: wiseId("42", "profileId"), name: "profileId" }, "balance-statements", { value: "7", name: "balanceId" }, "statement.json"]),
		).toBe("/profiles/42/balance-statements/7/statement.json");
	});

	it("rejects a segment that would change the path", () => {
		expect(() => wiseId("../admin", "transferId")).toThrow(PathParamError);
		expect(() => wiseId("0", "profileId")).toThrow(PathParamError);
		expect(() => apiPath(["profiles", { value: "a/b", name: "profileId" }])).toThrow(PathParamError);
	});
});
