import { handleRequest } from "./http.js";

export { AuthRateLimit } from "./auth-rate-limit.js";
export { RequestRateLimit } from "./request-rate-limit.js";

export default {
	fetch(request: Request, env: Env): Promise<Response> {
		return handleRequest(request, env);
	},
} satisfies ExportedHandler<Env>;
