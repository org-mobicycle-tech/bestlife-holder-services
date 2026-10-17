# Best Life holder services

Your own Best Life services, deployed into **your own** Cloudflare account. Your evidence, your keys and your AI
calls stay in your account. Best Life, the app owner, never holds your keys. It sees only what you let it read, over
a connection that proves it is Best Life.

Each worker does one job. Deploy only the ones your Settings call for. Best Life shows you exactly which ones under
**Settings › Stores › You bring your own** and in Onboarding.

| Worker | Its job | Deploy |
|---|---|---|
| `access` | Seals and opens your keys with your own encryption key. It hands them only to your other workers here, over service bindings. | [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/org-mobicycle-tech/bestlife-holder-services/tree/main/access) |
| `store` | Keeps your evidence in your own storage (R2), its index in your own database (D1) and recent reads in your own cache (KV). | [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/org-mobicycle-tech/bestlife-holder-services/tree/main/store) |
| `ingest-push` | The Email Routing target for your domain. It files each message in your store and tells Best Life it arrived, with metadata only. | [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/org-mobicycle-tech/bestlife-holder-services/tree/main/ingest-push) |
| `ingest-pull` | Reads your mailboxes over IMAP without changing them, and files each new message in your store. | [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/org-mobicycle-tech/bestlife-holder-services/tree/main/ingest-pull) |
| `send` | Sends your mail with Cloudflare Email Sending, falling back to Resend on your own key. It never sends twice. | [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/org-mobicycle-tech/bestlife-holder-services/tree/main/send) |
| `ai` | Asks your own AI on your own key. | [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/org-mobicycle-tech/bestlife-holder-services/tree/main/ai) |

**Deploy order:** `access`, then `store`, then the others. The others bind to these two by name
(`bestlife-holder-access` and `bestlife-holder-store`), so keep the default Worker names. If you rename one, change
the `service` in each binding that points at it.

## Why one button per worker

Cloudflare's Deploy to Cloudflare button deploys one Workers application. When a repository holds several Workers,
each one needs its own button and its own folder. Each folder must stand alone, with its own `package.json` and
dependencies, and it becomes the root of the new repository Cloudflare creates for you
([Deploy to Cloudflare buttons](https://developers.cloudflare.com/workers/platform/deploy-buttons/)). So each folder
here carries its own copy of the few shared files (`caller.ts`, `log.ts`, `runtime.ts`, and `tree.ts` / `file.ts`
where needed).

When you press a button, Cloudflare:

- clones that folder into a new repository on your GitHub or GitLab;
- lets you choose the repository name, the Worker name and the resource names;
- creates the KV namespaces, D1 database and R2 bucket the Worker needs, in your account;
- asks you for each secret listed in the folder's `.dev.vars.example`, using the descriptions in its `package.json`;
- builds and deploys the Worker with Workers Builds.

See the [Deploy to Cloudflare buttons](https://developers.cloudflare.com/workers/platform/deploy-buttons/) docs, the
[changelog post for the button](https://developers.cloudflare.com/changelog/post/2025-04-08-deploy-to-cloudflare-button/)
and [automatic resource provisioning](https://developers.cloudflare.com/changelog/post/2025-10-24-automatic-resource-provisioning/).

## GitHub or GitLab

Both work. Cloudflare's docs say the Deploy button takes a public **github.com or gitlab.com** repository. It
"clones your source repository into the user's GitHub/GitLab account", and self-hosted GitHub or GitLab is not
supported ([Deploy to Cloudflare buttons](https://developers.cloudflare.com/workers/platform/deploy-buttons/),
Limitations). Workers Builds connects a Worker to a GitHub or GitLab repository and deploys on every push
([Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/),
[GitLab integration](https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/gitlab-integration/)).

**With the button:** press it, and choose your GitLab account when Cloudflare asks where to create the repository.

**If the button does not offer GitLab for you,** the docs do not say whether it copies a GitHub source into a GitLab
account. In that case, do it by hand:

1. On GitLab, choose **New project › Import project › Repository by URL**, with
   `https://github.com/org-mobicycle-tech/bestlife-holder-services.git`.
2. In Cloudflare, go to **Workers & Pages › Create application › GitLab** and select that project.
3. Set the **root directory** to the worker's folder (for example `store`). Keep the Worker name
   `bestlife-holder-<folder>`; it must match the `name` in that folder's `wrangler.jsonc`.
4. Deploy. Wrangler creates the KV, D1 and R2 the worker needs in your account.

How this path differs from the button:

- Nothing prompts you for secrets. Add them under **Settings › Variables and Secrets** (for `access`: `ENCRYPTION_KEY`).
- One GitLab project can serve all six workers. Connect it once per worker, each with its own root directory, as a
  monorepo.
- GitLab shows build results as commit statuses where GitHub uses check runs.

Either way, the connection is between **your** GitLab or GitHub account and **your** Cloudflare account. You authorize
it in Cloudflare's dashboard. Best Life never holds a GitHub or GitLab token for you. If one of your workers ever
needs a token, keep it on your `access` worker as a `KEY_<NAME>` secret.

## Nothing is exposed

Every worker sets `workers_dev: false` and `preview_urls: false`, so none has a `*.workers.dev` address.

- **`access`** has no route at all. Only your other workers reach it, over service bindings. A request that arrives
  from the internet is refused.
- **`ingest-push`** is reached only by Email Routing: **Email › Email Routing › Routing rules › Send to a Worker**.
- **`ingest-pull`** runs only on its schedule (every 15 minutes).
- **`store`, `send` and `ai`** are the only ones Best Life calls. To let it, give each one a Custom Domain on a zone
  you own (**Workers › your worker › Settings › Domains & Routes**). Then turn on mTLS for that hostname
  (**SSL/TLS › Client Certificates**, then a WAF rule that requires a verified client certificate on it). Set
  `BESTLIFE_CALLER_CN` to the certificate name shown in Settings › Stores. Each worker checks, on every call, that
  Cloudflare verified a client certificate with that exact name. A token is never accepted. Until you set
  `BESTLIFE_CALLER_CN`, Best Life cannot call the worker at all.

## Your keys

- **`ENCRYPTION_KEY`** (asked for when you deploy `access`): 32 random bytes, base64 (`openssl rand -base64 32`).
  Keep a copy somewhere safe.
- **Each key your workers need** is a secret on the `access` worker, named `KEY_<NAME>`. Add them under **Workers ›
  bestlife-holder-access › Settings › Variables and Secrets**, or with `wrangler secret put`:
  - `KEY_IMAP_PASSWORD`: an app password for a mailbox `ingest-pull` reads. Name more of them `KEY_<anything>` and
    point each mailbox's `key` at its name.
  - `KEY_RESEND_API_KEY`: your Resend key, for `send`.
  - `KEY_AI_API_KEY`: your AI provider's key, for `ai`.
- Keys never go to Best Life, never go to GitHub and never reach a log.

## Telling Best Life mail arrived

`ingest-push` and `ingest-pull` tell Best Life a message arrived with metadata only: evidence, address, id, size and
time, never the message. Each notice is signed with your **connection key**, the `CONNECTION_KEY` secret Best Life's
Settings makes you (`blck1.…`, shown once). Best Life's door checks the signature against the public half it keeps,
that the notice is fresh, and that you hold the address. No token is ever sent. Add the secret to the worker after
deploying. Without it nothing is told, and your mail is still filed in your store.

## Logs

Each worker writes one readable JSON line per event, such as `filed`, `sent`, `refused` or `falling back`, with only
these fields: path, address, id, size, status, via, why, count, name, who and ms. A subject, a message body, a
prompt, an answer or a key never reaches the logs. Each worker has a test that checks this.

## Registering with Best Life

After deploying, open **Settings › Stores › You bring your own** in Best Life. For each worker Best Life calls
(`store`, `send`, `ai`), paste its custom domain and the SHA-256 fingerprint of its certificate. Best Life records
them in your own Settings. "Still to set up" then shows each worker as registered. Once Best Life has its mTLS
client in place, it also shows whether each one answers `/healthz`.

## Checks

In each folder:

```sh
bun install
bun run check                    # typecheck (ES2020, no platform type packages) and the folder's tests
bunx wrangler deploy --dry-run   # bundle and list the bindings, without deploying
```

## License

MIT
