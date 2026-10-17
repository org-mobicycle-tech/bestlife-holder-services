# bestlife-holder-ingest-pull

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/org-mobicycle-tech/bestlife-holder-services/tree/main/ingest-pull)

Reads your mailboxes over IMAP (TLS, port 993) every 15 minutes and files each new message in your store, as
`ingest-push` does. Messages are fetched with `BODY.PEEK[]`, so nothing is marked read, moved or deleted. Each mailbox's
password is opened by your `access` worker when needed, and never kept or logged.

**Set up:** deploy `access` and `store` first. Add each mailbox's app password to `access` as a `KEY_<NAME>` secret.
Then set `MAILBOXES`:

```json
[{"address":"you@example.com","host":"imap.example.com","port":993,"user":"you@example.com","key":"IMAP_PASSWORD"}]
```

`PER_RUN` (default 25) caps how many new messages are read per mailbox per run. Where each mailbox got to is kept in
`STATE`.

**Telling Best Life:** as `ingest-push`, signed with your `CONNECTION_KEY` secret.

Checks: `bun install && bun run check && bunx wrangler deploy --dry-run`.
