# bestlife-holder-access

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/org-mobicycle-tech/bestlife-holder-services/tree/main/access)

Seals and opens your keys with your own encryption key, and hands them only to your other Best Life workers,
over service bindings. No route, no workers.dev, no preview URL: a request from the internet is refused.

| Route (binding only) | |
|---|---|
| `POST /seal {name, value}` | seal a key into KEYS (AES-GCM, your ENCRYPTION_KEY, the name as additional data) |
| `POST /open {name}` | the key: a `KEY_<NAME>` secret, else the sealed one |
| `GET /names` | the names held, never a value |
| `GET /healthz` | whether ENCRYPTION_KEY is set and 32 bytes |

**Asked for when you deploy:** `ENCRYPTION_KEY` (`openssl rand -base64 32`; keep a copy). Add each key as a secret
named `KEY_<NAME>` (Settings › Variables and Secrets): `KEY_IMAP_PASSWORD`, `KEY_RESEND_API_KEY`, `KEY_AI_API_KEY`.

Any of your workers bound to this one can open any key here. Bind it only to the Best Life workers in this repository.

Checks: `bun install && bun run check && bunx wrangler deploy --dry-run`.
