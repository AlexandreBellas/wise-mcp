import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Config } from "../config.js";
import { hasCredentials } from "../config.js";

export const READ_ONLY = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: true,
} as const;

export function ok(data: unknown): CallToolResult {
	return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export function err(text: string): CallToolResult {
	return { content: [{ type: "text", text }], isError: true };
}

export function requireCredentials(config: Config): CallToolResult | null {
	if (config.configError) return err(config.configError);
	if (hasCredentials(config)) return null;
	return err("This read requires a Wise personal API token. Set the WISE_API_TOKEN Worker secret.");
}

export async function read(fn: () => Promise<unknown>): Promise<CallToolResult> {
	try {
		return ok(await fn());
	} catch (error) {
		const message = error instanceof Error ? error.message : "Request failed.";
		return err(message);
	}
}
