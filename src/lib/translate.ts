/**
 * The one place the server calls a model: a description into Simplified Chinese, when someone
 * asks (design §2.8). Any OpenAI-compatible chat completions API, set by hand in `llm.json` in the
 * secrets dir (`{ "base": "https://api.openai.com/v1", "key": "sk-…", "model": "…" }`); without
 * the file there is no translation and the page does not offer one.
 */
import { readJson } from "./secrets";

export interface LlmConfig {
  base: string;
  key: string;
  model: string;
}

const LLM_FILE = "llm.json";
const TIMEOUT_MS = 60_000;

export function llmConfig(): LlmConfig | null {
  const raw = readJson<Partial<LlmConfig>>(LLM_FILE);
  const [base, key, model] = [raw?.base, raw?.key, raw?.model].map((v) => (typeof v === "string" ? v.trim() : ""));
  return base && key && model ? { base, key, model } : null;
}

const PROMPT =
  "你是金融翻译。把用户给出的公司、基金或资产简介翻译成简体中文：忠实原文，不增不减，不加解释和标题；公司名、基金名、产品名和股票代码保留原文，必要时在第一次出现时附上通用的中文译名；数字和单位照原样。只输出译文。";

const log = (msg: string) => console.warn(`[hebi8m] translate: ${msg}`);

// A model that cannot be reached or answers with an error is not for the person who clicked to
// fix: they are told to try again later, and the status and what came back go to the server log.
const UNREACHABLE = "连不上翻译服务，请稍后再试";
const FAILED = "翻译服务返回了错误，请稍后再试";

/** The model's Simplified Chinese for `text`; throws what to tell the person when it fails. */
export async function translateToChinese(text: string, llm: LlmConfig): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${llm.base.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${llm.key}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: llm.model,
        temperature: 0,
        messages: [
          { role: "system", content: PROMPT },
          { role: "user", content: text },
        ],
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    log(`no answer from ${llm.base}: ${err instanceof Error ? err.message : String(err)}`);
    throw new Error(UNREACHABLE);
  }
  const body = await res.text();
  let content: unknown;
  try {
    content = (JSON.parse(body) as { choices?: { message?: { content?: unknown } }[] }).choices?.[0]?.message?.content;
  } catch {
    // an error page instead of JSON: reported below with the status
  }
  if (!res.ok || typeof content !== "string" || !content.trim()) {
    log(`model API ${res.status}: ${body.slice(0, 300)}`);
    throw new Error(FAILED);
  }
  return content.trim();
}
