# wise-mcp

Read-only [Model Context Protocol](https://modelcontextprotocol.io) server for the [Wise Platform API](https://docs.wise.com/api-reference). It runs on Cloudflare Workers (free plan) and exposes profiles, balances, statements, activities, transfers, exchange rates, and receiving account details. It cannot create quotes, recipients, or transfers, and it cannot fund or cancel a transfer.

Responses are normalized for import into Firefly III: `id`, `date`, `amount`, `currency`, `direction`, `counterparty`, `description`, `fees`, and `runningBalance` where Wise provides them. Activity rows also include the second currency, the sign, and the raw Wise display strings.

## Endpoint

1. `GET /health` returns `{ "status": "ok" }`.
2. `POST /mcp` is the stateless Streamable HTTP MCP endpoint.
3. Every `/mcp` request must send `Authorization: Bearer <MCP_AUTH_TOKEN>`.
4. A missing or wrong token gets `401` with a JSON-RPC error body.
5. Repeated failures from the same client IP are locked out (`429`) by a SQLite Durable Object.
6. Authenticated `/mcp` requests are limited to 60 per minute for that bearer token and 600 per minute for the whole Worker. The limit returns `429` with `Retry-After` and does not call Wise. `GET /health` is not limited.
7. Outbound Wise GETs are capped at 5 per second. A Wise `429` stores `Retry-After` (1 second when the header is missing, 2 minutes maximum) and the next Wise call waits. The Worker does not retry the failed call itself.

## Secrets

Set these as Worker secrets. Do not put the values in the repo, in `wrangler.jsonc`, or in git.

| Secret | Role |
| --- | --- |
| `WISE_API_TOKEN` | Wise personal API token. Sent as `Authorization: Bearer` to Wise. |
| `MCP_AUTH_TOKEN` | Bearer token your MCP client must present. The Worker compares it in constant time. |
| `WISE_SCA_PRIVATE_KEY` | Optional. Unencrypted PKCS#8 RSA PEM used to sign an SCA challenge. Omit it until you upload the matching public key. |

The Worker refuses `/mcp` when `MCP_AUTH_TOKEN` is missing. The Wise token and the private key are never logged, never written to a Durable Object, and never placed in a URL.

```bash
npx wrangler secret put WISE_API_TOKEN
npx wrangler secret put MCP_AUTH_TOKEN
npx wrangler secret put WISE_SCA_PRIVATE_KEY < private.pem
```

For local `npm run dev`, copy `.dev.vars.example` to `.dev.vars` and fill the same names. `.dev.vars` is gitignored. Do not commit `private.pem`.

## Configuration

Plain vars in `wrangler.jsonc`. They are not secrets.

| Var | Default | Role |
| --- | --- | --- |
| `WISE_API_BASE` | `https://api.wise.com` | Wise host only. Sandbox: `https://api.wise-sandbox.com`. Any other host is refused before the token is sent. |
| `WISE_API_VERSION` | `2026Q4` | Quarterly path prefix, for example `/2026Q4/profiles`. |
| `AUTH_FAILURE_LIMIT` | `10` | Failed MCP bearer attempts per client IP before lockout. |
| `AUTH_FAILURE_WINDOW_SECONDS` | `900` | Window those failures are counted in. |
| `AUTH_LOCKOUT_SECONDS` | `1800` | How long the IP stays locked. |
| `RATE_LIMIT_PER_MINUTE` | `60` | Authenticated `/mcp` calls per bearer token. |
| `RATE_LIMIT_GLOBAL_PER_MINUTE` | `600` | Authenticated `/mcp` calls for the whole Worker. |
| `WISE_PER_SECOND` | `5` | Outbound Wise GETs. Wise publishes `429` and `Retry-After`, not a fixed quota. |

`WISE_API_BASE` must be the host only, with no path, query, user, or password. Switch to sandbox by changing that host. Keep `WISE_API_VERSION` unless Wise publishes a newer quarter.

## Personal API token

Create a token in Wise. This server only sends GET.

1. Sign in at [wise.com](https://wise.com).
2. Open Settings, then API tokens (Connect and manage apps).
3. Create a personal token and copy it into `WISE_API_TOKEN`.
4. Do not grant the token to a client that can create transfers. This server has no write tools. A personal token is still a live credential.

UK and EEA profiles need Strong Customer Authentication for balance statements and some transfer reads. This server signs that challenge when `WISE_SCA_PRIVATE_KEY` is set. See below.

## Client configuration

Point a remote MCP client at `https://<your-worker>.workers.dev/mcp` and send the bearer token:

```json
{
  "mcpServers": {
    "wise": {
      "url": "https://wise-mcp.<account>.workers.dev/mcp",
      "headers": {
        "Authorization": "Bearer <MCP_AUTH_TOKEN>"
      }
    }
  }
}
```

## Tools

All 11 tools are registered in every deployment. Each one is read-only.

| Tool | What it reads |
| --- | --- |
| `wise_status` | Whether the Wise token, the API host, and SCA signing are configured. No token, no private key, and no balances. |
| `wise_list_profiles` | Profile id, type, name, and state. Address, email, phone, and date of birth are omitted. |
| `wise_list_balances` | Multi-currency balances for one profile. `types` is `STANDARD`, `SAVINGS`, or both. |
| `wise_get_balance` | One balance by profile id and balance id. |
| `wise_get_balance_statement` | Statement lines for one balance and a UTC range of at most 469 days. |
| `wise_list_activities` | Activity feed. Parses both display amounts, including thousands separators, signs, and Wise tags. |
| `wise_list_transfers` | Outgoing transfers. Filters: status, source currency, target currency, created date range, `limit` (1–100), `offset`. |
| `wise_get_transfer` | One outgoing transfer by id. |
| `wise_get_exchange_rates` | Current pairs, one pair, one historical timestamp, or a `from`/`to`/`group` range. |
| `wise_list_account_details` | Receiving bank details for a profile (IBAN, account number, sort code, BIC). |
| `wise_get_account_details` | One receiving-account record by id. |

Amounts are decimal strings with trailing zeros removed (`216.10` becomes `216.1`). `direction` is `in` or `out`. A statement debit is `out`. A statement credit is `in`. Listed transfers are outgoing, so `direction` is `out`, with both source and target amounts. `counterparty` is the merchant or sender name when the statement has one. Transfer rows only have `counterpartyAccountId` (the recipient account id). Wise does not return the recipient name on the transfer.

### Balance statement and SCA

`wise_get_balance_statement` calls `GET /2026Q4/profiles/{profileId}/balance-statements/{balanceId}/statement.json`. `wise_get_transfer` and any other read can meet the same challenge. The retry is still that same GET.

1. `currency`, `intervalStart`, and `intervalEnd` are required. `type` is `COMPACT` (default) or `FLAT`.
2. The range cannot exceed 469 days.
3. For profiles outside the US, AU, NZ, SG, CA, and MY, Wise protects statement GETs with Strong Customer Authentication.
4. Wise returns HTTP 403 and an `x-2fa-approval` one-time token. The signature is SHA-256 with RSA over that token (`openssl sha256 -sign`), standard Base64, sent back as `X-Signature` with the same token in `x-2fa-approval`.
5. When `WISE_SCA_PRIVATE_KEY` is set, this server signs the token with WebCrypto (`RSASSA-PKCS1-v1_5`, SHA-256) and retries the GET once. The token and the signature are not returned and are not logged.
6. When the secret is missing, the tool returns a fixed error that names the secret and the key format. It does not return the one-time token.
7. A second 403 after a signature is not signed again. Check that the uploaded public key matches this private key.
8. The account holder name and address from the statement are not returned.
9. Each challenge uses two of the outbound Wise GETs (the 403, then the retry).

#### Key format

The secret is an unencrypted PKCS#8 PEM. The header is `-----BEGIN PRIVATE KEY-----` and the footer is `-----END PRIVATE KEY-----`. RSA, 2048 bits or more. A 2048-bit PEM is about 1.7 KB. A Worker secret on the free plan holds 5 KB, so use 2048 or 4096, not a larger key. Do not encrypt the PEM with a passphrase. WebCrypto cannot import PKCS#1 (`-----BEGIN RSA PRIVATE KEY-----`).

Generate the pair and upload only the public key:

```bash
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out private.pem
openssl rsa -pubout -in private.pem -out public.pem
```

`private.pem` is PKCS#8. `public.pem` starts with `-----BEGIN PUBLIC KEY-----`.

If you already followed Wise's older `openssl genrsa` example, that file is PKCS#1. Convert it before setting the secret:

```bash
openssl pkcs8 -topk8 -nocrypt -in private.pem -out private-pkcs8.pem
```

Upload `public.pem` in Wise: Settings, then API tokens, then Manage public keys. Wise asks for 2FA. An account can store at most 5 public keys. Then:

```bash
npx wrangler secret put WISE_SCA_PRIVATE_KEY < private.pem
```

`wise_status` reports `scaSigningConfigured`. It is true only when the secret imports as a usable key. A bad secret sets `scaConfigError` and does not block the other tools. Never commit either PEM. `.gitignore` ignores `*.pem` and `*.key`.

### Activity amounts

Wise documents `primaryAmount` and `secondaryAmount` as display text, not numbers. Examples in the activity schema are `150 JPY` and `1.50 SGD`. Either field may be empty. This feed has no running balance and no separate fee. The title may contain `<strong>`, `<positive>`, `<negative>`, and `<strike>` (`<strike>` means the activity was negated, for example a cancelled transfer). Live amount strings use the same tags, thousands separators, an explicit `+` or `-`, and sometimes both currencies in one string (`1,234.56 BRL → 216.10 EUR`, also `->`, `=>`, `to`, `/`, `|`, `—`, or `>`).

1. `amount` and `currency` are the first currency amount in `primaryAmount`.
2. `secondaryAmount` and `secondaryCurrency` come from the `secondaryAmount` field when that field contains an amount. When Wise left that field empty and the primary string contains two amounts, the second one is used.
3. `primaryAmountDisplay` and `secondaryAmountDisplay` are Wise's strings with the tags kept (outer whitespace trimmed), so you can audit the parse. They are null when Wise omitted the field.
4. `sign` and `secondarySign` are the explicit `+` or `-` printed on that figure, or null. A unicode minus counts as `-`. The amount itself is absolute.
5. `direction` is the activity direction. A `<negative>` or `<positive>` on the title wins. If the title has both, or neither, the primary figure's tag or sign is used. If a figure's own text has both tags, that text does not decide. `secondaryDirection` is only that figure's tag or sign.
6. A 3-letter uppercase code before or after the number is the currency. `1,234.56` and `1.234,56` use the last separator as the decimal mark. `1,234` is thousands. A single `.` is a decimal point (`1.50`, `1.234`). Spaces inside the number, including non-breaking spaces, are ignored.
7. `<strike>` around a figure sets `struck` or `secondaryStruck`. The number is still returned. `<strike>` on the title sets `negated`. Do not book a figure as settled money when its flag is true, and do not book the activity when `negated` is true. `direction` still describes the cancelled movement when a tag or a sign makes it clear. Unknown tags such as `<strong>` are removed and do not change the sign, the direction, or `struck`.

```json
{
  "amount": "1234.56",
  "currency": "BRL",
  "sign": "-",
  "direction": "out",
  "secondaryAmount": "216.1",
  "secondaryCurrency": "EUR",
  "secondarySign": null,
  "secondaryDirection": null,
  "primaryAmountDisplay": "<negative>- 1,234.56 BRL</negative>",
  "secondaryAmountDisplay": "216.10 EUR",
  "struck": false,
  "secondaryStruck": false,
  "negated": false
}
```

A struck primary amount looks like this: `primaryAmountDisplay` is `<strike>80.00 GBP</strike>`, `amount` is `80`, `currency` is `GBP`, `struck` is true, and `direction` is null unless a sign or a `<negative>` / `<positive>` tag is also present.

### Account details

1. `wise_list_account_details` calls the legacy `GET /v1/profiles/{profileId}/account-details` on the same host. A personal token can read it. The 2026Q4 reference no longer lists this route. An optional `currency` filter is sent when you set one. Hidden rows are dropped.
2. `wise_get_account_details` calls `GET /2026Q4/balances/account-details/{id}`. The 2026Q4 reference allows a user token or a client-credential token on that route, not a personal token. If Wise rejects the personal token, the tool returns that HTTP error. Institution street addresses are omitted.

## Develop

Node.js 22 or newer.

```bash
npm install
npm test
npm run lint
npm run typecheck
npx wrangler deploy --dry-run
```

`npm run dev` serves the Worker locally. Point a client at `http://127.0.0.1:8787/mcp` with the same `Authorization` header.

## Deploy

Cloudflare Workers Builds, production branch `main`.

1. In the Cloudflare dashboard, open Workers & Pages and connect this repository.
2. Worker name: `wise-mcp` (already set in `wrangler.jsonc`).
3. Deploy command: `npm run deploy`.
4. Set `WISE_API_TOKEN` and `MCP_AUTH_TOKEN` before the first successful deploy. Add `WISE_SCA_PRIVATE_KEY` only when you want SCA signing.
5. Leave non-production branch builds off unless you want a preview Worker.

`npm run deploy` is `wrangler deploy`. The free plan is enough: the Worker script and two SQLite Durable Objects. This project does not use Workers AI, Queues, KV, or the Rate Limiting binding.

## Not supported

1. Creating, funding, or cancelling transfers.
2. Creating quotes, recipients, balances, or bank-detail orders. A quote is a POST, so priced send quotes are not available. Exchange rates are the read-only price.
3. Listing recipients. `GET /accounts` in the 2026Q4 reference allows a user OAuth token, not a personal token.
4. SCA for a route Wise challenges when `WISE_SCA_PRIVATE_KEY` is not set, or when the uploaded public key does not match.
5. Card sensitive details, webhooks, simulations, and any route that is not a GET this server already calls.
6. Wise does not publish a numeric rate limit in the API reference. The Worker uses its own caps and honours `429` / `Retry-After`.

## Disclaimer

This software is provided as is, with no warranty. It is not affiliated with, endorsed by, or operated by Wise. You are responsible for your Wise account, the personal API token, the SCA private key, and the bearer token that protects this Worker.

## License

MIT. See [LICENSE](LICENSE).
