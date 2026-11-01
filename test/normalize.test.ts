import { describe, expect, it } from "vitest";
import {
	normalizeAccountDetails,
	normalizeActivities,
	normalizeProfiles,
	normalizeStatement,
	normalizeTransfer,
} from "../src/normalize.js";

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
			direction: "out",
			description: "Sent — Invoice 7",
			reference: "99",
			runningBalance: null,
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
