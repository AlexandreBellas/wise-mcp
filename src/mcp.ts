import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CredentialEnv } from "./config.js";
import type { QuotaEnv } from "./request-gate.js";
import { createWiseServer } from "./server.js";

/** Stateless Streamable HTTP. One server and transport per request; no session id. */
export async function handleMcpRequest(request: Request, env: CredentialEnv & QuotaEnv): Promise<Response> {
	const server = createWiseServer(env);
	const transport = new WebStandardStreamableHTTPServerTransport({
		sessionIdGenerator: undefined,
		enableJsonResponse: true,
	});
	await server.connect(transport);
	try {
		return await transport.handleRequest(request);
	} finally {
		await transport.close().catch(() => undefined);
		await server.close().catch(() => undefined);
	}
}
