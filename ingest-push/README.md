# bestlife-holder-ingest-push

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/org-mobicycle-tech/bestlife-holder-services/tree/main/ingest-push)

The Email Routing target for your domain. Each message is filed, as it came, at
`inbox/email/<to>/<sha256-id>.eml` in your store, its envelope in your index. Best Life is told it arrived with metadata
only. It never forwards and never replies. If your store refuses, the message is rejected back to Email Routing.

**Set up:** deploy `store` first. Then **Email › Email Routing › Routing rules**: send the addresses (or the
catch-all) to the Worker `bestlife-holder-ingest-push`.

**Vars:** `BESTLIFE_HOLDER`, `BESTLIFE_ARRIVED_URL`, both of which can stay empty. Add a `BESTLIFE_TOKEN` secret only
when Settings › Stores gives you one.

Checks: `bun install && bun run check && bunx wrangler deploy --dry-run`.
