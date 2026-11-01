/**
 * Wise activity amounts are display strings, not numbers.
 * The activity schema (primaryAmount / secondaryAmount) says each value is
 * currency-formatted text such as "150 JPY" or "1.50 SGD", and that the
 * title may contain <strong>, <positive>, <negative>, and <strike>.
 * Live payloads also put those tags, thousands separators, and a second
 * currency on the amount strings themselves.
 *
 * <strike> on a figure means Wise drew it crossed out (cancelled, reversed,
 * or superseded). The number is still returned. Callers must not book a
 * struck figure, or a title marked <strike>, as settled money.
 */

export type AmountSign = "+" | "-";

export type DisplayFigure = {
	amount: string | null;
	currency: string | null;
	sign: AmountSign | null;
	direction: "in" | "out" | null;
	struck: boolean;
};

export type ParsedActivityAmounts = {
	primary: DisplayFigure;
	secondary: DisplayFigure | null;
};

type Frame = { positive: boolean; negative: boolean; strike: boolean };

const EMPTY_FRAME: Frame = { positive: false, negative: false, strike: false };

const TAG = /<\/?([A-Za-z][A-Za-z0-9]*)\b[^>]*>/g;

const MONEY =
	/(?<![A-Za-z0-9])([+\-\u2212])?\s*(?:([A-Z]{3})(?=\s|\d)\s*)?(\d{1,3}(?:[ \u00a0\u202f.,]\d{3})*(?:[.,]\d+)?|\d+(?:[.,]\d+)?)(?:\s*([A-Z]{3}))?(?![A-Za-z])/g;

const ENTITY = /&(#x[0-9a-fA-F]+|#\d+|nbsp|amp|lt|gt|quot|apos);/g;

export function parseActivityAmounts(primaryDisplay: string | null, secondaryDisplay: string | null): ParsedActivityAmounts {
	const primaryHits = primaryDisplay === null ? [] : extractMoney(primaryDisplay);
	const secondaryHits = secondaryDisplay === null ? [] : extractMoney(secondaryDisplay);
	const secondary = secondaryHits[0] ?? (secondaryDisplay === null ? (primaryHits[1] ?? null) : null);
	return { primary: primaryHits[0] ?? emptyFigure(), secondary };
}

export function inspectMarkup(value: string): { plain: string | null; direction: "in" | "out" | null; negated: boolean } {
	const decoded = decodeDisplay(value);
	const positive = decoded.flags.some((flag) => flag.positive);
	const negative = decoded.flags.some((flag) => flag.negative);
	const collapsed = decoded.plain.replace(/[ \t\f\v\u00a0\u202f]+/g, " ").trim();
	return {
		plain: collapsed.length > 0 ? collapsed : null,
		direction: positive === negative ? null : negative ? "out" : "in",
		negated: decoded.flags.some((flag) => flag.strike),
	};
}

function extractMoney(display: string): DisplayFigure[] {
	const decoded = decodeDisplay(display);
	const figures: DisplayFigure[] = [];
	for (const match of decoded.plain.matchAll(new RegExp(MONEY.source, "g"))) {
		const figure = figureFromMatch(match, decoded.flags);
		if (figure === null) continue;
		figures.push(figure);
		if (figures.length === 2) break;
	}
	return figures;
}

function figureFromMatch(match: RegExpMatchArray, flags: Frame[]): DisplayFigure | null {
	const number = match[3];
	if (number === undefined) return null;
	const currency = currencyOf(match[4]) ?? currencyOf(match[2]);
	const amount = currency === null ? null : parseGroupedNumber(number);
	if (currency === null || amount === null) return null;
	const index = match.index ?? 0;
	const span = flags.slice(index, index + match[0].length);
	const frame = span.reduce<Frame>(
		(combined, flag) => ({
			positive: combined.positive || flag.positive,
			negative: combined.negative || flag.negative,
			strike: combined.strike || flag.strike,
		}),
		EMPTY_FRAME,
	);
	const sign = match[1] === "+" ? "+" : match[1] === "-" || match[1] === "\u2212" ? "-" : null;
	return { amount, currency, sign, direction: polarity(frame, sign), struck: frame.strike };
}

function polarity(frame: Frame, sign: AmountSign | null): "in" | "out" | null {
	if (frame.positive !== frame.negative) return frame.negative ? "out" : "in";
	if (sign === "+") return "in";
	if (sign === "-") return "out";
	return null;
}

function currencyOf(value: string | undefined): string | null {
	if (value === undefined) return null;
	const code = value.toUpperCase();
	return /^[A-Z]{3}$/.test(code) ? code : null;
}

/**
 * Last separator wins when both comma and dot appear (`1,234.56` and `1.234,56`).
 * A comma used only in groups of three is a thousands separator (`1,234`).
 * A single dot is a decimal point (`1.50`, `1.234`), matching the documented examples.
 * Several dots in groups of three are thousands (`1.234.567`).
 */
function parseGroupedNumber(raw: string): string | null {
	const compact = raw.replace(/[ \u00a0\u202f]/g, "");
	if (!/^\d/.test(compact) || !/\d$/.test(compact)) return null;
	const comma = compact.lastIndexOf(",");
	const dot = compact.lastIndexOf(".");
	let body: string;
	if (comma >= 0 && dot >= 0) {
		const decimalSep = comma > dot ? "," : ".";
		const thousandSep = decimalSep === "," ? "." : ",";
		const splitAt = decimalSep === "," ? comma : dot;
		const intRaw = compact.slice(0, splitAt);
		const fraction = compact.slice(splitAt + 1);
		if (!isThousands(intRaw, thousandSep) || !/^\d+$/.test(fraction)) return null;
		body = `${intRaw.split(thousandSep).join("")}.${fraction}`;
	} else if (comma >= 0 || dot >= 0) {
		const sep = comma >= 0 ? "," : ".";
		const pieces = compact.split(sep);
		if (pieces.some((piece) => !/^\d+$/.test(piece))) return null;
		const grouped = pieces.slice(1).every((piece) => piece.length === 3);
		if (sep === "," && grouped) body = pieces.join("");
		else if (sep === "." && pieces.length > 2 && grouped) body = pieces.join("");
		else if (pieces.length === 2) body = `${pieces[0]}.${pieces[1]}`;
		else return null;
	} else {
		body = compact;
	}
	if (!/^\d+(\.\d+)?$/.test(body) || body.length > 24) return null;
	return trimDecimal(body);
}

function isThousands(intRaw: string, separator: string): boolean {
	const pieces = intRaw.split(separator);
	if (pieces.length === 0 || pieces.some((piece) => !/^\d+$/.test(piece))) return false;
	return pieces.slice(1).every((piece) => piece.length === 3);
}

function decodeDisplay(value: string): { plain: string; flags: Frame[] } {
	const plainParts: string[] = [];
	const flags: Frame[] = [];
	const stack: string[] = [];
	let cursor = 0;
	for (const match of value.matchAll(TAG)) {
		const index = match.index ?? 0;
		appendText(value.slice(cursor, index));
		const name = match[1]?.toLowerCase();
		if (name === undefined) {
			cursor = index + match[0].length;
			continue;
		}
		if (match[0].startsWith("</")) {
			const at = stack.lastIndexOf(name);
			if (at >= 0) stack.splice(at, 1);
		} else if (!match[0].endsWith("/>")) {
			stack.push(name);
		}
		cursor = index + match[0].length;
	}
	appendText(value.slice(cursor));
	return { plain: plainParts.join(""), flags };

	function appendText(text: string): void {
		const decoded = decodeEntities(text);
		const frame = {
			positive: stack.includes("positive"),
			negative: stack.includes("negative"),
			strike: stack.includes("strike"),
		};
		for (let index = 0; index < decoded.length; index += 1) {
			plainParts.push(decoded.charAt(index));
			flags.push(frame);
		}
	}
}

function decodeEntities(text: string): string {
	return text.replace(ENTITY, (entity, body: string) => {
		if (body === "nbsp") return "\u00a0";
		if (body === "amp") return "&";
		if (body === "lt") return "<";
		if (body === "gt") return ">";
		if (body === "quot") return '"';
		if (body === "apos") return "'";
		const code = body.startsWith("#x") ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
		if (!Number.isInteger(code) || code < 32 || code === 127 || code > 0xffff) return entity;
		return String.fromCharCode(code);
	});
}

function emptyFigure(): DisplayFigure {
	return { amount: null, currency: null, sign: null, direction: null, struck: false };
}

function trimDecimal(value: string): string {
	if (!value.includes(".")) return value;
	const trimmed = value.replace(/0+$/, "").replace(/\.$/, "");
	return trimmed.length > 0 ? trimmed : "0";
}
