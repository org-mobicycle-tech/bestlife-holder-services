#!/usr/bin/env python3
"""Write each worker's package.json, wrangler.jsonc, tsconfig.json, .dev.vars.example and .gitignore, and copy the
shared files into each folder (each folder must stand alone for its Deploy button)."""
import json, os, shutil

HERE = os.path.dirname(os.path.abspath(__file__))
SHARED = {
    "access": ["caller", "log", "runtime"],
    "store": ["caller", "log", "runtime", "tree", "nonces"],
    "ingest-push": ["caller", "log", "runtime", "tree", "file"],
    "ingest-pull": ["caller", "log", "runtime", "tree", "file"],
    "send": ["caller", "log", "runtime", "nonces"],
    "ai": ["caller", "log", "runtime", "nonces"],
}
CN = {"BESTLIFE_CALLER_CN": "bestlife-caller"}
ARRIVED = {}
ACCESS = [{"binding": "ACCESS", "service": "bestlife-holder-access"}]
STORE = [{"binding": "STORE", "service": "bestlife-holder-store"}]

W = {
    "access": dict(
        job="Seals and opens your keys with your own encryption key, and hands them only to your other Best Life workers.",
        cfg={"kv_namespaces": [{"binding": "KEYS"}]},
        vars={},
        secrets={"ENCRYPTION_KEY": "Your own encryption key: 32 random bytes, base64. Make one with: openssl rand -base64 32. Keep a copy somewhere safe; without it sealed keys cannot be opened."},
        desc={"KEYS": "Where your sealed keys are kept (a KV namespace in your account)."},
    ),
    "store": dict(
        job="Keeps your evidence in your own storage (R2), its index in your own database (D1), and recent reads in your own cache (KV).",
        cfg={"r2_buckets": [{"binding": "STORAGE", "bucket_name": "bestlife-evidence"}],
             "d1_databases": [{"binding": "DB", "database_name": "bestlife-index"}],
             "kv_namespaces": [{"binding": "CACHE"}]},
        vars=dict(CN),
        secrets={},
        desc={"STORAGE": "Your evidence, as it came (an R2 bucket in your account).", "NONCES": "The signed requests already let in, so none is let in twice (a Durable Object in your account, free).",
              "DB": "The index of your evidence (a D1 database in your account).",
              "CACHE": "Envelopes read recently, kept for an hour (a KV namespace in your account)."},
    ),
    "ingest-push": dict(
        job="Receives the mail Email Routing sends it, files each message in your store, and tells Best Life it arrived (metadata only).",
        cfg={"services": STORE},
        vars={},
        secrets={},
        desc={"STORE": "Your store worker (deploy bestlife-holder-store first)."},
    ),
    "ingest-pull": dict(
        job="Reads your mailboxes over IMAP every 15 minutes, without changing them, and files each new message in your store.",
        cfg={"services": STORE + ACCESS, "kv_namespaces": [{"binding": "STATE"}], "triggers": {"crons": ["*/15 * * * *"]}},
        vars={"MAILBOXES": "[]", "PER_RUN": "25"},
        secrets={},
        desc={"STORE": "Your store worker (deploy bestlife-holder-store first).",
              "ACCESS": "Your access worker, which opens each mailbox's password (deploy bestlife-holder-access first).",
              "STATE": "The last message read in each mailbox (a KV namespace in your account)."},
    ),
    "send": dict(
        job="Sends your mail with Cloudflare Email Sending, and with Resend on your own key only when Cloudflare did not send it. Never twice.",
        cfg={"send_email": [{"name": "EMAIL"}], "services": ACCESS, "kv_namespaces": [{"binding": "SENT"}]},
        vars={"RESEND_KEY_NAME": "RESEND_API_KEY", **CN},
        secrets={},
        desc={"EMAIL": "Cloudflare Email Sending (needs Workers Paid and your domain onboarded in Email Service).", "NONCES": "The signed requests already let in, so none is let in twice (a Durable Object in your account, free).",
              "ACCESS": "Your access worker, which opens your Resend key (deploy bestlife-holder-access first).",
              "SENT": "What was sent, so nothing is sent twice (a KV namespace in your account)."},
    ),
    "ai": dict(
        job="Asks your own AI on your own key, so your evidence goes only to the AI provider you chose.",
        cfg={"services": ACCESS},
        vars={"AI_PROVIDER": "anthropic", "AI_MODEL": "claude-opus-5-5", "AI_ENDPOINT": "", "AI_KEY_NAME": "AI_API_KEY", "MAX_TOKENS": "16000", **CN},
        secrets={},
        desc={"ACCESS": "Your access worker, which opens your AI key (deploy bestlife-holder-access first).", "NONCES": "The signed requests already let in, so none is let in twice (a Durable Object in your account, free)."},
    ),
}
VAR_DESC = {
    "BESTLIFE_CALLER_CN": "The name Best Life signs its requests as: bestlife-caller. Leave it as it is. Empty: Best Life cannot call this worker.",
    "MAILBOXES": 'Your mailboxes, as JSON: [{"address":"you@example.com","host":"imap.example.com","port":993,"user":"you@example.com","key":"IMAP_PASSWORD"}]. Each key names a KEY_<key> secret on your access worker.',
    "PER_RUN": "At most this many new messages per mailbox per run.",
    "RESEND_KEY_NAME": "The name of your Resend key on your access worker (a KEY_RESEND_API_KEY secret there).",
    "AI_PROVIDER": "anthropic, or openai-compatible for a model you run.",
    "AI_MODEL": "The model to ask (claude-opus-5-5 for Anthropic).",
    "AI_ENDPOINT": "For openai-compatible only: the base URL of your endpoint (https://…/v1).",
    "AI_KEY_NAME": "The name of your AI key on your access worker (a KEY_AI_API_KEY secret there).",
    "MAX_TOKENS": "The longest answer, in tokens.",
}

TSCONFIG = {"compilerOptions": {"target": "es2020", "lib": ["es2020", "WebWorker"], "module": "esnext", "moduleResolution": "Bundler",
            "noEmit": True, "isolatedModules": True, "forceConsistentCasingInFileNames": True, "strict": True, "skipLibCheck": True, "types": []},
            "include": ["src/**/*.ts"]}

for name, w in W.items():
    d = os.path.join(HERE, name)
    for f in SHARED[name]:
        shutil.copy(os.path.join(HERE, "_shared", "src", f + ".ts"), os.path.join(d, "src", f + ".ts"))
    test = [t for t in os.listdir(os.path.join(d, "test")) if t.endswith(".ts")][0]
    pkg = {
        "name": f"bestlife-holder-{name}", "version": "1.0.0", "private": True, "type": "module",
        "description": w["job"],
        "scripts": {"deploy": "wrangler deploy", "typecheck": "tsc --noEmit", "check": f"tsc --noEmit && bun test/{test}"},
        **({"dependencies": {"@anthropic-ai/sdk": "^0.135.0"}} if name == "ai" else {}),
        "devDependencies": {"typescript": "^7.0.2", "wrangler": "^4.129.0"},
        "cloudflare": {"label": f"Best Life holder · {name}",
                       "bindings": {**{k: {"description": v} for k, v in w["secrets"].items()},
                                    **{k: {"description": VAR_DESC[k]} for k in w["vars"]},
                                    **{k: {"description": v} for k, v in w["desc"].items()}}},
    }
    with open(os.path.join(d, "package.json"), "w") as fh:
        json.dump(pkg, fh, indent=2); fh.write("\n")
    with open(os.path.join(d, "tsconfig.json"), "w") as fh:
        json.dump(TSCONFIG, fh, indent=2); fh.write("\n")
    cfg = {"$schema": "node_modules/wrangler/config-schema.json", "name": f"bestlife-holder-{name}", "main": "src/index.ts",
           "compatibility_date": "2026-10-01", "workers_dev": False, "preview_urls": False,
           "observability": {"enabled": True, "logs": {"enabled": True, "invocation_logs": True}}}
    if w["vars"]:
        cfg["vars"] = w["vars"]
    cfg.update(w["cfg"])
    if "nonces" in SHARED[name]:
        # ONCE ONLY (src/nonces.ts): the nonces already let in, a SQLite-backed Durable Object (Workers Free plan too).
        cfg["durable_objects"] = {"bindings": [{"name": "NONCES", "class_name": "SeenNonces"}]}
        cfg["migrations"] = [{"tag": "v1", "new_sqlite_classes": ["SeenNonces"]}]
    head = (f"// wrangler.jsonc -- bestlife-holder-{name}: {w['job']}\n"
            "// Deployed into YOUR Cloudflare account by its Deploy to Cloudflare button. No account id is written here: it\n"
            "// is your account. Nothing is exposed: no workers.dev and no preview URL (see README.md for how it is reached).\n")
    with open(os.path.join(d, "wrangler.jsonc"), "w") as fh:
        fh.write(head + json.dumps(cfg, indent="\t") + "\n")
    if w["secrets"]:
        with open(os.path.join(d, ".dev.vars.example"), "w") as fh:
            for k, v in w["secrets"].items():
                fh.write(f"# {v}\n{k}=\n")
    elif os.path.exists(os.path.join(d, ".dev.vars.example")):
        os.remove(os.path.join(d, ".dev.vars.example"))
    with open(os.path.join(d, ".gitignore"), "w") as fh:
        fh.write("node_modules/\n.wrangler/\n.dev.vars\ndist/\n")
print("assembled", ", ".join(W))
