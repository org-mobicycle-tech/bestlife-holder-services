# bestlife-holder-send

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/org-mobicycle-tech/bestlife-holder-services/tree/main/send)

Sends your mail. It tries **Cloudflare Email Sending** first (needs Workers Paid and your domain onboarded under
**Compute › Email Service › Email Sending**). It falls back to **Resend** on your own key, opened by `access`, only
when Cloudflare clearly refused. A clear refusal is one of Email Sending's own `E_…` refusal codes. Anything else is
an unknown outcome: it is answered with 409 "check before resending", and is never retried on the other path.

`POST /send {messageId, from, to, subject, text, html?, replyTo?, inReplyTo?}`

**Never twice.** Each `messageId` is recorded in `SENT` before anything is tried. If a message was sent, asking again
returns the same answer. Resend is called with `Idempotency-Key: messageId`. KV is not a lock, so Best Life never
sends the same `messageId` twice at once.

**Who may ask:** Best Life over your custom domain with mTLS (`BESTLIFE_CALLER_CN`), or a binding.

Docs: [Email Sending Workers API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/).

Checks: `bun install && bun run check && bunx wrangler deploy --dry-run`.
