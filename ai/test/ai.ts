// AI: the holder's own key from their access worker; Claude through the SDK with adaptive thinking and fallbacks;
// an openai-compatible endpoint for a model they run; prompts and answers never logged. No real provider is asked.
//
//   bun test/ai.ts
import worker, { ask, claudeParams, type ClaudeClient, type Env } from "../src/index";
import { OTHER_KEY, TEST_CN, TEST_KEY, signed, testNonces } from "./signer";

let failed = 0;
const is = (what: string, ok: boolean, saw = ""): void => {
	process.stdout.write((ok ? "ok    " : "FAIL  ") + what + (ok ? "" : "\n      " + saw) + "\n");
	if (!ok) failed += 1;
};

const ACCESS = { fetch: async () => Response.json({ name: "AI_API_KEY", value: "sk-holder-key" }) };
const env: Env = { ACCESS, BESTLIFE_CALLER_CN: TEST_CN, BESTLIFE_CALLER_KEY: TEST_KEY, NONCES: testNonces() };

// CLAUDE
let sent: Record<string, unknown> = {};
let keyUsed = "";
let stop = "end_turn";
const fake = (key: string): ClaudeClient => {
	keyUsed = key;
	return { beta: { messages: { stream: (p) => { sent = p; return { finalMessage: async () => ({ model: String(p.model), stop_reason: stop, content: [{ type: "thinking" }, { type: "text", text: "the answer" }] }) }; } } } };
};
const a1 = await ask(env, { system: "s", prompt: "private question" }, fake);
is("Claude answers on the holder's key", a1.ok && a1.text === "the answer" && keyUsed === "sk-holder-key", JSON.stringify(a1));
is("the default model is claude-opus-5-5", sent.model === "claude-opus-5-5");
is("adaptive thinking is asked for", JSON.stringify(sent.thinking) === JSON.stringify({ type: "adaptive" }));
is("server-side fallbacks are on", sent.fallbacks === "default" && JSON.stringify(sent.betas) === JSON.stringify(["server-side-fallback-2026-07-01"]));
is("no thinking budget is sent", !JSON.stringify(sent).includes("budget_tokens"));
stop = "refusal";
const a2 = await ask(env, { prompt: "q" }, fake);
is("a refusal is said plainly", !a2.ok && a2.status === 422);
stop = "end_turn";
is("a haiku model takes no fallbacks", !("fallbacks" in claudeParams("claude-haiku-5-5", 1000, { prompt: "q" })));

// OPENAI-COMPATIBLE
const calls: { url: string; auth: string; body: string }[] = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
	calls.push({ url: String(input), auth: new Headers(init?.headers).get("authorization") ?? "", body: String(init?.body ?? "") });
	return Response.json({ model: "llama-x", choices: [{ message: { content: "compatible answer" } }] });
}) as typeof fetch;
const env2: Env = { ...env, AI_PROVIDER: "openai-compatible", AI_ENDPOINT: "https://ai.holder.example/v1/", AI_MODEL: "llama-x" };
const a3 = await ask(env2, { system: "s", prompt: "q" });
is("an openai-compatible endpoint answers", a3.ok && a3.text === "compatible answer" && a3.provider === "openai-compatible", JSON.stringify(a3));
is("it is asked at <endpoint>/chat/completions on the holder's key", calls[0]?.url === "https://ai.holder.example/v1/chat/completions" && calls[0]?.auth === "Bearer sk-holder-key");
is("an endpoint that is not https is refused", !(await ask({ ...env2, AI_ENDPOINT: "http://x" }, { prompt: "q" })).ok);
is("an unknown provider is refused", !(await ask({ ...env, AI_PROVIDER: "other" }, { prompt: "q" })).ok);

// THE ROUTE
const req = (b: unknown, o: Parameters<typeof signed>[2] = {}) => signed("https://ai.example.com/ask", { method: "POST", body: JSON.stringify(b) }, o);
is("a signature by another key is refused", (await worker.fetch(await req({ prompt: "q" }, { key: OTHER_KEY }), env2)).status === 403);
const lines: string[] = [];
const was = console.log;
console.log = (...a: unknown[]) => { lines.push(a.join(" ")); };
const r = await worker.fetch(await req({ prompt: "private question" }), env2);
console.log = was;
is("Best Life's signed request gets the answer", r.status === 200 && ((await r.json()) as { text: string }).text === "compatible answer");
{
	const once = await req({ prompt: "q" });
	const again = once.clone() as Request & { cf?: unknown };
	Object.defineProperty(again, "cf", { value: {} });
	is("the same signed question asked twice is answered once", (await worker.fetch(once, env2)).status === 200 && (await worker.fetch(again, env2)).status === 403);
}
is("the logs never carry the prompt or the answer", lines.length > 0 && lines.every((l) => !l.includes("private") && !l.includes("compatible answer")), lines.join("\n"));

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log("\nall passed");
