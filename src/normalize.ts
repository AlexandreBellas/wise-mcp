export type Money = { amount: string; currency: string };

export type NormalizedTransaction = {
	id: string | null;
	date: string | null;
	amount: string | null;
	currency: string | null;
	direction: "in" | "out" | null;
	counterparty: string | null;
	description: string | null;
	fees: Money | null;
	runningBalance: Money | null;
	type: string | null;
	reference: string | null;
	status: string | null;
};

export type NormalizedProfile = {
	id: string | null;
	type: string | null;
	name: string | null;
	state: string | null;
};

export type NormalizedBalance = {
	id: string | null;
	currency: string | null;
	type: string | null;
	name: string | null;
	amount: Money | null;
	reservedAmount: Money | null;
	cashAmount: Money | null;
	totalWorth: Money | null;
	visible: boolean | null;
};

export type NormalizedRate = {
	rate: number | null;
	source: string | null;
	target: string | null;
	time: string | null;
};

export type NormalizedTransfer = {
	id: string | null;
	date: string | null;
	status: string | null;
	direction: "out";
	amount: string | null;
	currency: string | null;
	targetAmount: string | null;
	targetCurrency: string | null;
	rate: number | null;
	counterparty: null;
	counterpartyAccountId: string | null;
	description: string | null;
	fees: null;
	runningBalance: null;
	type: "TRANSFER";
	reference: string | null;
};

export type NormalizedAccountDetail = {
	id: string | null;
	currency: string | null;
	title: string | null;
	status: string | null;
	country: string | null;
	accountHolderName: string | null;
	details: Array<{ type: string | null; title: string | null; value: string | null }>;
};

const IDENTIFICATION_KEYS = ["bic", "iban", "sortCode", "accountNumber", "routingNumber", "institutionName"] as const;

export function decimalString(value: unknown): string | null {
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return null;
		return trimDecimal(trimmed);
	}
	if (typeof value !== "number" || !Number.isFinite(value)) return null;
	const negative = Object.is(value, -0) || value < 0;
	const fixed = Math.abs(value).toFixed(8).replace(/\.?0+$/, "");
	return negative && fixed !== "0" ? `-${fixed}` : fixed;
}

export function absoluteDecimal(value: unknown): string | null {
	const decimal = decimalString(value);
	if (decimal === null) return null;
	return decimal.startsWith("-") ? decimal.slice(1) : decimal;
}

export function money(value: unknown): Money | null {
	if (!value || typeof value !== "object") return null;
	const record = value as Record<string, unknown>;
	const amount = decimalString(record.value ?? record.amount);
	const currency = currencyCode(record.currency);
	if (amount === null || currency === null) return null;
	return { amount, currency };
}

export function normalizeProfiles(payload: unknown): NormalizedProfile[] {
	if (!Array.isArray(payload)) return [];
	return payload.map((item) => {
		const record = asRecord(item);
		const fullName = text(record?.fullName);
		const businessName = text(record?.businessName);
		const person = [text(record?.firstName), text(record?.lastName)].filter((part): part is string => part !== null);
		return {
			id: idText(record?.id),
			type: text(record?.type),
			name: fullName ?? businessName ?? (person.length > 0 ? person.join(" ") : null),
			state: text(record?.currentState),
		};
	});
}

export function normalizeBalances(payload: unknown): NormalizedBalance[] {
	const rows = Array.isArray(payload) ? payload : [];
	return rows.map((item) => {
		const record = asRecord(item);
		return {
			id: idText(record?.id),
			currency: currencyCode(record?.currency),
			type: text(record?.type),
			name: text(record?.name),
			amount: money(record?.amount),
			reservedAmount: money(record?.reservedAmount),
			cashAmount: money(record?.cashAmount),
			totalWorth: money(record?.totalWorth),
			visible: typeof record?.visible === "boolean" ? record.visible : null,
		};
	});
}

export function normalizeStatement(payload: unknown): {
	currency: string | null;
	intervalStart: string | null;
	intervalEnd: string | null;
	endBalance: Money | null;
	accountDetails: NormalizedAccountDetail[];
	transactions: NormalizedTransaction[];
} {
	const record = asRecord(payload);
	const query = asRecord(record?.query);
	const transactions = Array.isArray(record?.transactions) ? record.transactions : [];
	return {
		currency: currencyCode(query?.currency),
		intervalStart: text(query?.intervalStart),
		intervalEnd: text(query?.intervalEnd),
		endBalance: money(record?.endOfStatementBalance),
		accountDetails: normalizeStatementBankDetails(record?.bankDetails),
		transactions: transactions.map((item) => normalizeStatementTransaction(item)),
	};
}

export function normalizeActivities(payload: unknown): { cursor: string | null; transactions: NormalizedTransaction[] } {
	const record = asRecord(payload);
	const activities = Array.isArray(record?.activities) ? record.activities : [];
	return {
		cursor: text(record?.cursor),
		transactions: activities.map((item) => normalizeActivity(item)),
	};
}

export function normalizeTransfers(payload: unknown): NormalizedTransfer[] {
	if (!Array.isArray(payload)) return [];
	return payload.map((item) => normalizeTransfer(item));
}

export function normalizeTransfer(payload: unknown): NormalizedTransfer {
	const record = asRecord(payload);
	const details = asRecord(record?.details);
	const reference = text(details?.reference) ?? text(record?.reference);
	return {
		id: idText(record?.id),
		date: text(record?.created),
		status: text(record?.status),
		direction: "out",
		amount: absoluteDecimal(record?.sourceValue),
		currency: currencyCode(record?.sourceCurrency),
		targetAmount: absoluteDecimal(record?.targetValue),
		targetCurrency: currencyCode(record?.targetCurrency),
		rate: finiteNumber(record?.rate),
		counterparty: null,
		counterpartyAccountId: idText(record?.targetAccount),
		description: reference,
		fees: null,
		runningBalance: null,
		type: "TRANSFER",
		reference,
	};
}

export function normalizeRates(payload: unknown): NormalizedRate[] {
	if (!Array.isArray(payload)) return [];
	return payload.map((item) => {
		const record = asRecord(item);
		return {
			rate: finiteNumber(record?.rate),
			source: currencyCode(record?.source),
			target: currencyCode(record?.target),
			time: text(record?.time),
		};
	});
}

export function normalizeAccountDetails(payload: unknown): NormalizedAccountDetail[] {
	if (Array.isArray(payload)) return payload.map((item) => normalizeOneAccountDetail(item));
	if (payload && typeof payload === "object") return [normalizeOneAccountDetail(payload)];
	return [];
}

function normalizeStatementTransaction(payload: unknown): NormalizedTransaction {
	const record = asRecord(payload);
	const details = asRecord(record?.details);
	const merchant = asRecord(details?.merchant);
	const amountRecord = asRecord(record?.amount);
	const signed = decimalString(amountRecord?.value);
	const direction = directionFromType(record?.type) ?? directionFromSign(signed);
	const counterparty = text(merchant?.name) ?? text(details?.senderName);
	const description = text(details?.description) ?? text(details?.paymentReference) ?? text(details?.category);
	const fee = money(record?.totalFees) ?? money(details?.fee);
	return {
		id: text(record?.referenceNumber),
		date: text(record?.date),
		amount: signed === null ? null : signed.startsWith("-") ? signed.slice(1) : signed,
		currency: currencyCode(amountRecord?.currency),
		direction,
		counterparty,
		description,
		fees: fee,
		runningBalance: money(record?.runningBalance),
		type: text(details?.type) ?? text(record?.type),
		reference: text(details?.paymentReference) ?? text(record?.referenceNumber),
		status: null,
	};
}

function normalizeActivity(payload: unknown): NormalizedTransaction {
	const record = asRecord(payload);
	const title = text(record?.title) ?? "";
	const direction = title.includes("<negative>") ? "out" : title.includes("<positive>") ? "in" : null;
	const description = [stripTags(title), text(record?.description)].filter((part): part is string => part !== null && part !== "").join(" — ");
	const primary = parseDisplayAmount(record?.primaryAmount);
	const resource = asRecord(record?.resource);
	return {
		id: text(record?.id),
		date: text(record?.createdOn),
		amount: primary?.amount ?? null,
		currency: primary?.currency ?? null,
		direction,
		counterparty: null,
		description: description.length > 0 ? description : null,
		fees: null,
		runningBalance: null,
		type: text(record?.type) ?? text(resource?.type),
		reference: text(resource?.id),
		status: text(record?.status),
	};
}

function normalizeOneAccountDetail(payload: unknown): NormalizedAccountDetail {
	const record = asRecord(payload);
	const currencyObject = asRecord(record?.currency);
	const currency = currencyCode(record?.currency) ?? currencyCode(currencyObject?.code);
	const legacy = legacyDetails(record?.receiveOptions);
	const modern = identificationDetails(record?.accountIdentification);
	return {
		id: idText(record?.id),
		currency,
		title: text(record?.title),
		status: text(record?.status) ?? text(record?.state),
		country: text(record?.country),
		accountHolderName: text(record?.accountHolderName),
		details: legacy.length > 0 ? legacy : modern,
	};
}

function normalizeStatementBankDetails(payload: unknown): NormalizedAccountDetail[] {
	if (!payload || typeof payload !== "object") return [];
	return [normalizeOneAccountDetail(payload)];
}

function legacyDetails(payload: unknown): NormalizedAccountDetail["details"] {
	if (!Array.isArray(payload)) return [];
	const details: NormalizedAccountDetail["details"] = [];
	for (const option of payload) {
		const rows = asRecord(option)?.details;
		if (!Array.isArray(rows)) continue;
		for (const row of rows) {
			const record = asRecord(row);
			if (record?.hidden === true) continue;
			const value = text(record?.body);
			if (value === null) continue;
			details.push({ type: text(record?.type), title: text(record?.title), value });
		}
	}
	return details;
}

function identificationDetails(payload: unknown): NormalizedAccountDetail["details"] {
	const record = asRecord(payload);
	if (!record) return [];
	const nested = Object.values(record).find((value) => value && typeof value === "object" && !Array.isArray(value));
	const source = asRecord(nested) ?? record;
	const details: NormalizedAccountDetail["details"] = [];
	for (const key of IDENTIFICATION_KEYS) {
		const value = text(source[key]);
		if (value === null) continue;
		details.push({ type: key, title: key, value });
	}
	return details;
}

function parseDisplayAmount(value: unknown): Money | null {
	if (typeof value !== "string") return null;
	const match = /^(-?\d+(?:\.\d+)?)\s+([A-Z]{3})$/.exec(value.trim());
	if (!match) return null;
	const amount = absoluteDecimal(match[1]);
	const currency = currencyCode(match[2]);
	if (amount === null || currency === null) return null;
	return { amount, currency };
}

function directionFromType(value: unknown): "in" | "out" | null {
	if (value === "CREDIT") return "in";
	if (value === "DEBIT") return "out";
	return null;
}

function directionFromSign(signed: string | null): "in" | "out" | null {
	if (signed === null || signed === "0") return null;
	return signed.startsWith("-") ? "out" : "in";
}

function stripTags(value: string): string | null {
	const stripped = value.replace(/<[^>]*>/g, "").trim();
	return stripped.length > 0 ? stripped : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

function text(value: unknown): string | null {
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed.length > 0 ? trimmed : null;
	}
	return null;
}

function idText(value: unknown): string | null {
	if (typeof value === "string" && /^[0-9]{1,18}$/.test(value)) return value;
	if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
	return text(value);
}

function currencyCode(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const code = value.trim().toUpperCase();
	return /^[A-Z]{3}$/.test(code) ? code : null;
}

function finiteNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function trimDecimal(value: string): string {
	if (!value.includes(".")) return value === "-0" ? "0" : value;
	const trimmed = value.replace(/0+$/, "").replace(/\.$/, "");
	return trimmed === "-0" ? "0" : trimmed;
}
