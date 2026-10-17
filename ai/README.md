# bestlife-holder-ai

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/org-mobicycle-tech/bestlife-holder-services/tree/main/ai)

Asks your own AI on your own key (`KEY_AI_API_KEY` on `access`), so the evidence you ask about goes from your
account to the provider you chose and nowhere else.

`POST /ask {system?, prompt}` returns `{text, model, provider}`.

- **`AI_PROVIDER=anthropic`** (default): Claude, through the official `@anthropic-ai/sdk`, with model
  `claude-opus-5-5` and adaptive thinking. Server-side fallbacks are on (`fallbacks: "default"`): if Claude declines a
  request on policy grounds, the API re-runs it on Anthropic's recommended fallback model in the same call.
- **`AI_PROVIDER=openai-compatible`**: any `/chat/completions` endpoint you run (for example on Hetzner).
  `AI_ENDPOINT` is its https base URL and `AI_MODEL` its model name.

Prompts and answers are never logged.

**Who may ask:** Best Life over your custom domain with mTLS (`BESTLIFE_CALLER_CN`), or a binding.

Checks: `bun install && bun run check && bunx wrangler deploy --dry-run`.
