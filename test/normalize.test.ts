import { describe, expect, it } from "vitest";
import {
	normalizeAccountDetails,
	normalizeActivities,
	normalizeProfiles,
	normalizeStatement,
	normalizeTransfer,
	type NormalizedActivity,
} from "../src/normalize.js";

function activity(primaryAmount: string, extra: Record<string, unknown> = {}): NormalizedActivity {
	const page = normalizeActivities({
		activities: [
			{
				id: "activity-1",
				type: "TRANSFER",
				title: "<strong>Moved</strong>",
				description: "note",
				primaryAmount,
				status: "COMPLETED",
				createdOn: "2026-01-02T00:00:00.000Z",
				resource: { type: "TRANSFER", id: "99" },
				...extra,
			},
		],
	});
	const row = page.transactions[0];
	if (row === undefined) throw new Error("missing activity");
	return row;
}

describe("normalized Wise payloads", () => {
	it("drops profile contact data and keeps the name", () => {
		const profiles = normalizeProfiles([
			{
				id: 14575282,
				type: "PERSONAL",
				fullName: "Sarah Jenkins",
				currentState: "VISIBLE",
				email: "sarah.jenkins@example.com",
				phoneNumber: "+447700900456",
				dateOfBirth: "1985-05-20",
				address: { addressFirstLine: "24 Willow Creek Lane", city: "Bristol" },
			},
		]);
		expect(profiles).toEqual([{ id: "14575282", type: "PERSONAL", name: "Sarah Jenkins", state: "VISIBLE" }]);
		expect(JSON.stringify(profiles)).not.toContain("example.com");
		expect(JSON.stringify(profiles)).not.toContain("Willow");
	});

	it("maps a statement line to a Firefly-shaped transaction and drops the account holder", () => {
		const statement = normalizeStatement({
			accountHolder: { firstName: "Oliver", lastName: "Wilson", address: { addressFirstLine: "Veerenni 24" } },
			bankDetails: null,
			endOfStatementBalance: { value: 16.01, currency: "EUR" },
			query: { intervalStart: "2018-03-01T00:00:00Z", intervalEnd: "2018-04-30T23:59:59.999Z", currency: "EUR" },
			transactions: [
				{
					type: "DEBIT",
					date: "2018-04-30T08:47:05.832Z",
					amount: { value: -7.76, currency: "EUR" },
					totalFees: { value: 0.04, currency: "EUR" },
					details: {
						type: "CARD",
						description: "Card transaction issued by Tfl.gov.uk/cp",
						merchant: { name: "Tfl.gov.uk/cp" },
						paymentReference: "ride",
					},
					runningBalance: { value: 16.01, currency: "EUR" },
					referenceNumber: "CARD-249281",
				},
			],
		});
		expect(statement.transactions).toEqual([
			{
				id: "CARD-249281",
				date: "2018-04-30T08:47:05.832Z",
				amount: "7.76",
				currency: "EUR",
				direction: "out",
				counterparty: "Tfl.gov.uk/cp",
				description: "Card transaction issued by Tfl.gov.uk/cp",
				fees: { amount: "0.04", currency: "EUR" },
				runningBalance: { amount: "16.01", currency: "EUR" },
				type: "CARD",
				reference: "ride",
				status: null,
			},
		]);
		expect(statement.endBalance).toEqual({ amount: "16.01", currency: "EUR" });
		expect(JSON.stringify(statement)).not.toContain("Veerenni");
		expect(JSON.stringify(statement)).not.toContain("Oliver");
	});

	it("parses an activity display amount and strips emphasis tags", () => {
		const page = normalizeActivities({
			cursor: "next-page",
			activities: [
				{
					id: "activity-1",
					type: "TRANSFER",
					title: "<negative><strong>Sent</strong></negative>",
					description: "Invoice 7",
					primaryAmount: "80.5 GBP",
					status: "COMPLETED",
					createdOn: "2026-01-02T00:00:00.000Z",
					resource: { type: "TRANSFER", id: "99" },
				},
			],
		});
		expect(page.cursor).toBe("next-page");
		expect(page.transactions[0]).toMatchObject({
			id: "activity-1",
			amount: "80.5",
			currency: "GBP",
			sign: null,
			direction: "out",
			secondaryAmount: null,
			secondaryCurrency: null,
			secondarySign: null,
			secondaryDirection: null,
			primaryAmountDisplay: "80.5 GBP",
			secondaryAmountDisplay: null,
			struck: false,
			secondaryStruck: false,
			negated: false,
			description: "Sent — Invoice 7",
			reference: "99",
			runningBalance: null,
		});
	});

	it("parses thousands separators, signs, tags, and both currencies", () => {
		const converted = activity("<negative>- 1,234.56 BRL → 216.10 EUR</negative>", {
			title: "<strong>Converted</strong>",
			description: "Balance",
		});
		expect(converted).toMatchObject({
			amount: "1234.56",
			currency: "BRL",
			sign: "-",
			direction: "out",
			secondaryAmount: "216.1",
			secondaryCurrency: "EUR",
			secondarySign: null,
			secondaryDirection: "out",
			primaryAmountDisplay: "<negative>- 1,234.56 BRL → 216.10 EUR</negative>",
			secondaryAmountDisplay: null,
			struck: false,
			secondaryStruck: false,
			negated: false,
			description: "Converted — Balance",
		});

		const split = activity("<negative>- 1,234.56 BRL</negative>", {
			secondaryAmount: "216.10 EUR",
			title: "Converted",
		});
		expect(split).toMatchObject({
			amount: "1234.56",
			currency: "BRL",
			sign: "-",
			direction: "out",
			secondaryAmount: "216.1",
			secondaryCurrency: "EUR",
			secondarySign: null,
			secondaryDirection: null,
			primaryAmountDisplay: "<negative>- 1,234.56 BRL</negative>",
			secondaryAmountDisplay: "216.10 EUR",
			struck: false,
		});

		expect(activity("<positive>+ 100 EUR</positive>", { title: "Top up" })).toMatchObject({
			amount: "100",
			currency: "EUR",
			sign: "+",
			direction: "in",
			primaryAmountDisplay: "<positive>+ 100 EUR</positive>",
			struck: false,
		});
		expect(activity("<positive><strong>+&nbsp;1,234.56&nbsp;EUR</strong></positive>")).toMatchObject({
			amount: "1234.56",
			currency: "EUR",
			sign: "+",
			direction: "in",
		});
		expect(activity("150 JPY", { secondaryAmount: "1.50 SGD", title: "Card" })).toMatchObject({
			amount: "150",
			currency: "JPY",
			secondaryAmount: "1.5",
			secondaryCurrency: "SGD",
			direction: null,
			primaryAmountDisplay: "150 JPY",
			secondaryAmountDisplay: "1.50 SGD",
		});
		expect(activity("EUR 1,234.56")).toMatchObject({ amount: "1234.56", currency: "EUR", sign: null });
		expect(activity("1.234,56 EUR")).toMatchObject({ amount: "1234.56", currency: "EUR" });
		expect(activity("1.50 SGD")).toMatchObject({ amount: "1.5", currency: "SGD" });
		expect(activity("1.234 EUR")).toMatchObject({ amount: "1.234", currency: "EUR" });
		expect(activity("1.234.567 EUR")).toMatchObject({ amount: "1234567", currency: "EUR" });
		expect(activity("1 234,56 EUR")).toMatchObject({ amount: "1234.56", currency: "EUR" });
		expect(activity("1\u00a0234.56 EUR")).toMatchObject({ amount: "1234.56", currency: "EUR" });
		expect(activity("1\u202f234.56 EUR")).toMatchObject({ amount: "1234.56", currency: "EUR" });
		expect(activity("\u2212 12.00 USD")).toMatchObject({ amount: "12", currency: "USD", sign: "-", direction: "out" });
		expect(activity("100 USD -> 80 GBP")).toMatchObject({ amount: "100", currency: "USD", secondaryAmount: "80", secondaryCurrency: "GBP" });
		expect(activity("100 USD => 80.00 GBP")).toMatchObject({ secondaryAmount: "80", secondaryCurrency: "GBP" });
		expect(activity("100 USD to 80 GBP")).toMatchObject({ secondaryCurrency: "GBP" });
		expect(activity("100 USD / 80 GBP")).toMatchObject({ secondaryAmount: "80", secondaryCurrency: "GBP" });
		expect(activity("100 USD | 80 GBP")).toMatchObject({ secondaryCurrency: "GBP" });
		expect(activity("100 USD — 80 GBP")).toMatchObject({ secondaryCurrency: "GBP" });
		expect(activity("100 USD > 80 GBP")).toMatchObject({ secondaryCurrency: "GBP" });
		expect(activity("Topping up 100 USD balance with 80 GBP")).toMatchObject({
			amount: "100",
			currency: "USD",
			secondaryAmount: "80",
			secondaryCurrency: "GBP",
		});
		expect(activity("1,234.56")).toMatchObject({ amount: null, currency: null, primaryAmountDisplay: "1,234.56" });
	});

	it("keeps struck figures for audit and does not treat them as settled direction-only noise", () => {
		expect(activity("<strike>80.00 GBP</strike>", { title: "Card" })).toMatchObject({
			amount: "80",
			currency: "GBP",
			sign: null,
			direction: null,
			struck: true,
			negated: false,
			primaryAmountDisplay: "<strike>80.00 GBP</strike>",
		});
		expect(activity("<strike><negative>- 20.00 EUR</negative></strike>", { title: "Card" })).toMatchObject({
			amount: "20",
			currency: "EUR",
			sign: "-",
			direction: "out",
			struck: true,
			negated: false,
		});
		expect(activity("1,234.56 BRL → <strike>216.10 EUR</strike>", { title: "Converted" })).toMatchObject({
			amount: "1234.56",
			currency: "BRL",
			struck: false,
			secondaryAmount: "216.1",
			secondaryCurrency: "EUR",
			secondaryStruck: true,
		});
		expect(activity("<strike>1,234.56 BRL → 216.10 EUR</strike>", { title: "Converted" })).toMatchObject({
			amount: "1234.56",
			secondaryAmount: "216.1",
			struck: true,
			secondaryStruck: true,
			direction: null,
		});
		const cancelled = activity("80 GBP", {
			title: "<strike><strong>Cancelled transfer</strong></strike>",
			description: "Invoice 7",
		});
		expect(cancelled).toMatchObject({
			amount: "80",
			currency: "GBP",
			direction: null,
			struck: false,
			negated: true,
			description: "Cancelled transfer — Invoice 7",
		});
		expect(activity("50 EUR", { title: "<positive>Received</positive>" })).toMatchObject({ direction: "in", sign: null });
		expect(activity("<positive>+ 50 EUR</positive>", { title: "<negative>Sent</negative>" })).toMatchObject({
			direction: "out",
			sign: "+",
		});
	});

	it("normalizes a transfer and legacy account details", () => {
		expect(
			normalizeTransfer({
				id: 16521632,
				status: "outgoing_payment_sent",
				created: "2017-11-24 10:47:49",
				sourceCurrency: "EUR",
				sourceValue: 100,
				targetCurrency: "GBP",
				targetValue: 89,
				rate: 0.89,
				targetAccount: 8692237,
				details: { reference: "Invoice 2026-001" },
			}),
		).toMatchObject({
			id: "16521632",
			direction: "out",
			amount: "100",
			currency: "EUR",
			targetAmount: "89",
			targetCurrency: "GBP",
			counterpartyAccountId: "8692237",
			reference: "Invoice 2026-001",
			fees: null,
		});

		const accounts = normalizeAccountDetails([
			{
				id: 111,
				currency: { code: "EUR", name: "Euro" },
				title: "EUR account",
				status: "ACTIVE",
				receiveOptions: [
					{
						type: "LOCAL",
						details: [
							{ type: "IBAN", title: "IBAN", body: "BE71096123456769", hidden: false },
							{ type: "SECRET", title: "Hidden", body: "do-not-show", hidden: true },
						],
					},
				],
			},
		]);
		expect(accounts[0]?.details).toEqual([{ type: "IBAN", title: "IBAN", value: "BE71096123456769" }]);
	});
});
