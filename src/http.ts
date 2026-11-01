import { authorizeMcpRequest, type AuthEnv } from "./auth-gate.js";
import { MCP_PATH, SERVER_NAME, SERVER_VERSION } from "./constants.js";
import type { CredentialEnv } from "./config.js";
import { handleMcpRequest } from "./mcp.js";
import { enforceRequestQuota, type QuotaEnv } from "./request-gate.js";

export type AppEnv = AuthEnv & CredentialEnv & QuotaEnv;

export type McpHandler = (request: Request, env: AppEnv) => Promise<Response>;

export async function handleRequest(request: Request, env: AppEnv, mcp: McpHandler = handleMcpRequest): Promise<Response> {
	const url = new URL(request.url);

	if (url.pathname === "/health" && request.method === "GET") {
		return Response.json({ status: "ok", service: SERVER_NAME, version: SERVER_VERSION });
	}

	if (url.pathname === MCP_PATH) {
		const denied = await authorizeMcpRequest(request, env);
		if (denied) return denied;
		const limited = await enforceRequestQuota(request, env);
		if (limited) return limited;
		return mcp(request, env);
	}

	return new Response("Not found", {
		status: 404,
		headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
	});
}
