import packageJson from "../package.json";

export const SERVER_NAME = "wise-mcp";
export const SERVER_VERSION = packageJson.version;

/** Hosts this server may call. Personal tokens are sent only to these origins. */
export const WISE_PRODUCTION_ORIGIN = "https://api.wise.com";
export const WISE_SANDBOX_ORIGIN = "https://api.wise-sandbox.com";

export const DEFAULT_WISE_API_BASE = WISE_PRODUCTION_ORIGIN;
export const DEFAULT_WISE_API_VERSION = "2026Q4";

export const MCP_PATH = "/mcp";

/** A successful Wise JSON body larger than this is refused instead of buffered. */
export const MAX_RESPONSE_BYTES = 2_000_000;

/** Error bodies are read only to pick a short public code. */
export const MAX_ERROR_BODY_BYTES = 8_192;

const production = new URL(WISE_PRODUCTION_ORIGIN);
const sandbox = new URL(WISE_SANDBOX_ORIGIN);
if (
	production.protocol !== "https:" ||
	sandbox.protocol !== "https:" ||
	production.pathname !== "/" ||
	sandbox.pathname !== "/" ||
	production.origin !== WISE_PRODUCTION_ORIGIN ||
	sandbox.origin !== WISE_SANDBOX_ORIGIN
) {
	throw new Error("Wise host allowlist is inconsistent.");
}
