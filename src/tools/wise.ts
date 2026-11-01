import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WiseClient } from "../client.js";
import type { Config } from "../config.js";
import {
	normalizeAccountDetails,
	normalizeActivities,
	normalizeBalances,
	normalizeProfiles,
	normalizeRates,
	normalizeStatement,
	normalizeTransfer,
	normalizeTransfers,
} from "../normalize.js";
import { apiPath, wiseId } from "../paths.js";
import { read, READ_ONLY, requireCredentials } from "./result.js";

const ACTIVITY_STATUSES = ["REQUIRES_ATTENTION", "IN_PROGRESS", "UPCOMING", "COMPLETED", "CANCELLED"] as const;
const ACTIVITY_RESOURCES = [
	"ACCRUAL_CHARGE",
	"ACQUIRING_PAYMENT",
	"ASSETS_WITHDRAWAL",
	"BALANCE_CASHBACK",
	"BALANCE_INTEREST",
	"BALANCE_TRANSACTION",
	"BANK_DETAILS_ORDER",
	"BATCH_TRANSFER",
	"CARD_CASHBACK",
	"CARD_ORDER",
	"CARD_TRANSACTION",
	"DIRECT_DEBIT_INSTRUCTION",
	"DIRECT_DEBIT_TRANSACTION",
	"FEE_REFUND",
	"INCIDENT_REFUND",
	"INCORPORATION_ORDER",
	"OPERATIONAL_TRANSACTION",
	"PAYMENT_REQUEST",
	"REWARD",
	"REWARDS_REDEMPTION",
	"SEND_ORDER",
	"SEND_ORDER_EXECUTION",
	"TRANSFER",
] as const;

const MAX_STATEMENT_MS = 469 * 24 * 60 * 60 * 1000;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const TRANSFER_STATUSES = /^[a-z][a-z0-9_]{0,40}(?:,[a-z][a-z0-9_]{0,40}){0,15}$/;
const CURSOR = /^[A-Za-z0-9+/=_-]{1,1024}$/;

export function registerWiseTools(server: McpServer, client: WiseClient, config: Config): void {
	server.registerTool(
		"wise_list_profiles",
		{
			description:
				"List Wise profiles for the personal API token. Returns id, type, name, and state. Omits address, email, phone, and date of birth.",
			inputSchema: {},
			annotations: READ_ONLY,
		},
		async () => {
			const denied = requireCredentials(config);
			if (denied) return denied;
			return read(async () => ({ profiles: normalizeProfiles(await client.get("/profiles")) }));
		},
	);

	server.registerTool(
		"wise_list_balances",
		{
			description:
				"List multi-currency balances for one profile. types is STANDARD, SAVINGS, or both (default STANDARD). Amounts are decimal strings.",
			inputSchema: {
				profileId: z.string().describe("Wise profile id from wise_list_profiles"),
				types: z.string().optional().describe("Comma-separated STANDARD and/or SAVINGS. Default STANDARD"),
			},
			annotations: READ_ONLY,
		},
		async ({ profileId, types }) => {
			const denied = requireCredentials(config);
			if (denied) return denied;
			return read(async () => {
				const id = wiseId(profileId, "profileId");
				const selected = balanceTypes(types);
				const balances = normalizeBalances(
					await client.get(apiPath(["profiles", { value: id, name: "profileId" }, "balances"]), { types: selected }),
				);
				return { profileId: id, types: selected, balances };
			});
		},
	);

	server.registerTool(
		"wise_get_balance",
		{
			description: "Get one balance by profile id and balance id.",
			inputSchema: {
				profileId: z.string().describe("Wise profile id"),
				balanceId: z.string().describe("Balance id from wise_list_balances"),
			},
			annotations: READ_ONLY,
		},
		async ({ profileId, balanceId }) => {
			const denied = requireCredentials(config);
			if (denied) return denied;
			return read(async () => {
				const profile = wiseId(profileId, "profileId");
				const balance = wiseId(balanceId, "balanceId");
				const rows = normalizeBalances(
					[
						await client.get(
							apiPath(["profiles", { value: profile, name: "profileId" }, "balances", { value: balance, name: "balanceId" }]),
						),
					],
				);
				return { profileId: profile, balance: rows[0] ?? null };
			});
		},
	);

	server.registerTool(
		"wise_get_balance_statement",
		{
			description:
				"Balance statement for one balance and a UTC date range (max 469 days). Returns normalized transactions for Firefly: id, date, amount, currency, direction, counterparty, description, fees, running balance. UK/EEA profiles need Strong Customer Authentication. A personal token then gets a clear SCA error instead of the statement. COMPACT puts fees on the transaction. FLAT puts fees on their own line.",
			inputSchema: {
				profileId: z.string().describe("Wise profile id"),
				balanceId: z.string().describe("Balance id"),
				currency: z.string().describe("ISO 4217 currency, for example EUR"),
				intervalStart: z.string().describe("Range start, UTC ISO-8601, for example 2026-01-01T00:00:00Z"),
				intervalEnd: z.string().describe("Range end, UTC ISO-8601"),
				type: z.enum(["COMPACT", "FLAT"]).optional().describe("Default COMPACT"),
				statementLocale: z.string().optional().describe("Two-letter language code, for example en"),
			},
			annotations: READ_ONLY,
		},
		async ({ profileId, balanceId, currency, intervalStart, intervalEnd, type, statementLocale }) => {
			const denied = requireCredentials(config);
			if (denied) return denied;
			return read(async () => {
				const profile = wiseId(profileId, "profileId");
				const balance = wiseId(balanceId, "balanceId");
				const code = currencyCode(currency, "currency");
				const start = isoTime(intervalStart, "intervalStart");
				const end = isoTime(intervalEnd, "intervalEnd");
				assertStatementRange(start, end);
				const locale = statementLocale === undefined ? undefined : localeCode(statementLocale);
				const statement = normalizeStatement(
					await client.get(
						apiPath([
							"profiles",
							{ value: profile, name: "profileId" },
							"balance-statements",
							{ value: balance, name: "balanceId" },
							"statement.json",
						]),
						{
							currency: code,
							intervalStart: start,
							intervalEnd: end,
							type: type ?? "COMPACT",
							statementLocale: locale,
						},
					),
				);
				return { profileId: profile, balanceId: balance, statementType: type ?? "COMPACT", ...statement };
			});
		},
	);

	server.registerTool(
		"wise_list_activities",
		{
			description:
				"Activity feed for a profile. Use this when the balance statement returns an SCA error. Amounts are taken only when Wise sends a display string like \"150 JPY\". Running balance and fees are not on this feed. Pass cursor back as nextCursor. size is 1 to 100 (default 100).",
			inputSchema: {
				profileId: z.string().describe("Wise profile id"),
				since: z.string().optional().describe("Include activities after this UTC ISO-8601 time"),
				until: z.string().optional().describe("Include activities until this UTC ISO-8601 time"),
				status: z.enum(ACTIVITY_STATUSES).optional().describe("Activity status filter"),
				monetaryResourceType: z.enum(ACTIVITY_RESOURCES).optional().describe("Resource type filter, for example TRANSFER"),
				size: z.number().int().min(1).max(100).optional().describe("Page size, default 100"),
				nextCursor: z.string().optional().describe("Cursor from the previous page"),
			},
			annotations: READ_ONLY,
		},
		async ({ profileId, since, until, status, monetaryResourceType, size, nextCursor }) => {
			const denied = requireCredentials(config);
			if (denied) return denied;
			return read(async () => {
				const id = wiseId(profileId, "profileId");
				const page = normalizeActivities(
					await client.get(apiPath(["profiles", { value: id, name: "profileId" }, "activities"]), {
						since: since === undefined ? undefined : isoTime(since, "since"),
						until: until === undefined ? undefined : isoTime(until, "until"),
						status,
						monetaryResourceType,
						size: String(size ?? 100),
						nextCursor: nextCursor === undefined ? undefined : cursor(nextCursor),
					}),
				);
				return { profileId: id, cursor: page.cursor, transactions: page.transactions };
			});
		},
	);

	server.registerTool(
		"wise_list_transfers",
		{
			description:
				"List outgoing transfers. Filters: status (comma-separated Wise statuses), sourceCurrency, targetCurrency, createdDateStart, createdDateEnd. limit is 1 to 100 (default 20). offset pages through the list. Amounts are the source and target values. Wise does not include the recipient name or a running balance here.",
			inputSchema: {
				profileId: z.string().optional().describe("Profile id. Omit to use the personal profile"),
				status: z.string().optional().describe("Comma-separated statuses, for example outgoing_payment_sent,cancelled"),
				sourceCurrency: z.string().optional().describe("Source currency, for example EUR"),
				targetCurrency: z.string().optional().describe("Target currency, for example GBP"),
				createdDateStart: z.string().optional().describe("Inclusive start, ISO-8601"),
				createdDateEnd: z.string().optional().describe("Inclusive end, ISO-8601"),
				limit: z.number().int().min(1).max(100).optional().describe("Page size, default 20, max 100"),
				offset: z.number().int().min(0).max(100_000).optional().describe("Number of transfers to skip"),
			},
			annotations: READ_ONLY,
		},
		async (args) => {
			const denied = requireCredentials(config);
			if (denied) return denied;
			return read(async () => {
				const limit = args.limit ?? 20;
				const offset = args.offset ?? 0;
				const transfers = normalizeTransfers(
					await client.get("/transfers", {
						profile: args.profileId === undefined ? undefined : wiseId(args.profileId, "profileId"),
						status: args.status === undefined ? undefined : transferStatuses(args.status),
						sourceCurrency: args.sourceCurrency === undefined ? undefined : currencyCode(args.sourceCurrency, "sourceCurrency"),
						targetCurrency: args.targetCurrency === undefined ? undefined : currencyCode(args.targetCurrency, "targetCurrency"),
						createdDateStart: args.createdDateStart === undefined ? undefined : isoTime(args.createdDateStart, "createdDateStart"),
						createdDateEnd: args.createdDateEnd === undefined ? undefined : isoTime(args.createdDateEnd, "createdDateEnd"),
						limit: String(limit),
						offset: String(offset),
					}),
				);
				return { limit, offset, count: transfers.length, transfers };
			});
		},
	);

	server.registerTool(
		"wise_get_transfer",
		{
			description: "Get one outgoing transfer by id. Same normalized shape as wise_list_transfers.",
			inputSchema: { transferId: z.string().describe("Transfer id") },
			annotations: READ_ONLY,
		},
		async ({ transferId }) => {
			const denied = requireCredentials(config);
			if (denied) return denied;
			return read(async () => {
				const id = wiseId(transferId, "transferId");
				return { transfer: normalizeTransfer(await client.get(apiPath(["transfers", { value: id, name: "transferId" }]))) };
			});
		},
	);

	server.registerTool(
		"wise_get_exchange_rates",
		{
			description:
				"Exchange rates. Omit source and target for every current pair. Set source and target for one pair. Set time for one historical timestamp. Set from, to, and group (day, hour, or minute) for a range. Do not combine time with from or to. Sandbox does not serve from, to, or group.",
			inputSchema: {
				source: z.string().optional().describe("Source currency, for example EUR"),
				target: z.string().optional().describe("Target currency, for example USD"),
				time: z.string().optional().describe("Historical timestamp, ISO-8601"),
				from: z.string().optional().describe("Range start, ISO-8601"),
				to: z.string().optional().describe("Range end, ISO-8601"),
				group: z.enum(["day", "hour", "minute"]).optional().describe("Range grouping"),
			},
			annotations: READ_ONLY,
		},
		async ({ source, target, time, from, to, group }) => {
			const denied = requireCredentials(config);
			if (denied) return denied;
			return read(async () => {
				if (time !== undefined && (from !== undefined || to !== undefined || group !== undefined)) {
					throw new Error("Pass either time or from/to/group, not both.");
				}
				if ((from !== undefined || to !== undefined || group !== undefined) && (from === undefined || to === undefined || group === undefined)) {
					throw new Error("A rate range needs from, to, and group together.");
				}
				const rates = normalizeRates(
					await client.get("/rates", {
						source: source === undefined ? undefined : currencyCode(source, "source"),
						target: target === undefined ? undefined : currencyCode(target, "target"),
						time: time === undefined ? undefined : isoTime(time, "time"),
						from: from === undefined ? undefined : isoTime(from, "from"),
						to: to === undefined ? undefined : isoTime(to, "to"),
						group,
					}),
				);
				return { count: rates.length, rates };
			});
		},
	);

	server.registerTool(
		"wise_list_account_details",
		{
			description:
				"Bank details that can receive money into a profile balance (IBAN, account number, sort code, BIC). Uses the legacy GET /v1/profiles/{profileId}/account-details, which a personal token can call. The 2026Q4 reference no longer lists this route. Optional currency filter. Hidden detail rows are dropped.",
			inputSchema: {
				profileId: z.string().describe("Wise profile id"),
				currency: z.string().optional().describe("ISO 4217 currency filter, for example EUR"),
			},
			annotations: READ_ONLY,
		},
		async ({ profileId, currency }) => {
			const denied = requireCredentials(config);
			if (denied) return denied;
			return read(async () => {
				const id = wiseId(profileId, "profileId");
				const code = currency === undefined ? undefined : currencyCode(currency, "currency");
				const accounts = normalizeAccountDetails(await client.getLegacyAccountDetails(id, code));
				return { profileId: id, currency: code ?? null, accounts };
			});
		},
	);

	server.registerTool(
		"wise_get_account_details",
		{
			description:
				"Get one set of receiving account details by id (GET /balances/account-details/{id}). The 2026Q4 reference allows user and client-credential tokens on this route, not personal tokens. A personal token that Wise rejects returns the HTTP error. Institution street addresses are omitted.",
			inputSchema: { accountDetailsId: z.string().describe("Account details id") },
			annotations: READ_ONLY,
		},
		async ({ accountDetailsId }) => {
			const denied = requireCredentials(config);
			if (denied) return denied;
			return read(async () => {
				const id = wiseId(accountDetailsId, "accountDetailsId");
				const accounts = normalizeAccountDetails(
					await client.get(apiPath(["balances", "account-details", { value: id, name: "accountDetailsId" }])),
				);
				return { account: accounts[0] ?? null };
			});
		},
	);
}

function balanceTypes(value: string | undefined): string {
	const parts = (value ?? "STANDARD")
		.split(",")
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
	if (parts.length === 0 || parts.some((part) => part !== "STANDARD" && part !== "SAVINGS")) {
		throw new Error("types must be STANDARD, SAVINGS, or both.");
	}
	return [...new Set(parts)].join(",");
}

function currencyCode(value: string, name: string): string {
	const code = value.trim().toUpperCase();
	if (!/^[A-Z]{3}$/.test(code)) throw new Error(`${name} must be a 3-letter currency code.`);
	return code;
}

function isoTime(value: string, name: string): string {
	const text = value.trim();
	if (!ISO_TIME.test(text) || !Number.isFinite(Date.parse(text))) {
		throw new Error(`${name} must be an ISO-8601 date or timestamp.`);
	}
	return text;
}

function assertStatementRange(start: string, end: string): void {
	const startMs = Date.parse(start);
	const endMs = Date.parse(end);
	if (endMs <= startMs) throw new Error("intervalEnd must be after intervalStart.");
	if (endMs - startMs > MAX_STATEMENT_MS) throw new Error("The statement range cannot exceed 469 days.");
}

function localeCode(value: string): string {
	const code = value.trim().toLowerCase();
	if (!/^[a-z]{2}$/.test(code)) throw new Error("statementLocale must be a 2-letter language code.");
	return code;
}

function transferStatuses(value: string): string {
	const text = value.trim();
	if (!TRANSFER_STATUSES.test(text)) throw new Error("status must be a comma-separated list of Wise transfer statuses.");
	return text;
}

function cursor(value: string): string {
	const text = value.trim();
	if (!CURSOR.test(text)) throw new Error("nextCursor is not a valid cursor.");
	return text;
}
