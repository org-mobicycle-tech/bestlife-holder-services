# bestlife-holder-store

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/org-mobicycle-tech/bestlife-holder-services/tree/main/store)

Your evidence in your own R2 bucket (`bestlife-evidence`), its index in your own D1 database
(`bestlife-index`), recent envelopes in your own KV cache. Items are kept at
`<folder>/<evidence>/<address>/<item>.<part>`. Nothing here deletes: trash is Best Life's method, asked of you.

| Route | |
|---|---|
| `PUT /item?path=` / `GET /item?path=` | keep an item (an item already kept stays as it is) / read it |
| `GET /list?prefix=&cursor=` | items under a folder, evidence or address |
| `PUT /index?path=` / `GET /index?path=` | write / read an item's envelope |
| `GET /envelopes?prefix=` | the newest 200 envelopes under a prefix |
| `GET /healthz` | whether storage, db and cache are bound |

**Who may ask:** your ingest workers over a binding; Best Life over your custom domain with mTLS, its certificate
named in `BESTLIFE_CALLER_CN`.

Checks: `bun install && bun run check && bunx wrangler deploy --dry-run`.
