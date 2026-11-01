import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WiseClient } from "./client.js";
import { SERVER_NAME, SERVER_VERSION } from "./constants.js";
import { hasCredentials, loadConfig, type CredentialEnv } from "./config.js";
import { outboundBudget, type QuotaEnv } from "./request-gate.js";
import { READ_ONLY, ok } from "./tools/result.js";
import { registerWiseTools } from "./tools/wise.js";

export function createWiseServer(env: CredentialEnv & QuotaEnv): McpServer {
	const config = loadConfig(env);
	const client = new WiseClient(config, outboundBudget(env));
	const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

	server.registerTool(
		"wise_status",
		{
			description:
				"Show whether this read-only Wise MCP server has an API token and a valid API host. Does not reveal the token or any balance.",
			inputSchema: {},
			annotations: READ_ONLY,
		},
		async () =>
			ok({
				service: SERVER_NAME,
				version: SERVER_VERSION,
				mode: "read-only",
				wiseCredentialsConfigured: hasCredentials(config),
				wiseApiBase: config.baseUrl || null,
				wiseApiVersion: config.apiVersion || null,
				configError: config.configError,
			}),
	);

	registerWiseTools(server, client, config);
	return server;
}
