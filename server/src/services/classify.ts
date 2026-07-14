// AI reply classifier — used ONLY when a platform doesn't label positive
// replies, so positive-reply counts stay consistent across agencies.
// Cost controls: (1) cache by message hash — a message is never classified
// twice; (2) hard daily cap (CLASSIFIER_DAILY_CAP) checked against the cache
// table; (3) cheapest model tier by default. Skipped entirely when
// ANTHROPIC_API_KEY is unset.
import { createHash } from "node:crypto";
import { q } from "../db/pool.js";
import { config } from "../config.js";
import { fetchWithRetry } from "../http.js";

export type Sentiment = "positive" | "neutral" | "negative";

export async function classifyReply(body: string): Promise<Sentiment | null> {
  if (!config.anthropicApiKey || !body.trim()) return null;
  const hash = createHash("sha256").update(body.trim().toLowerCase()).digest("hex");

  const cached = await q<{ sentiment: string }>(
    `select sentiment from reply_classifications where message_hash=$1`, [hash]);
  if (cached.rows[0]) return cached.rows[0].sentiment as Sentiment;

  const { rows } = await q<{ c: string }>(
    `select count(*) c from reply_classifications where classified_at >= date_trunc('day', now())`);
  if (Number(rows[0].c) >= config.classifierDailyCap) return null; // cap hit — try tomorrow

  try {
    const res = await fetchWithRetry("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": config.anthropicApiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: config.classifierModel,
        max_tokens: 5,
        messages: [{
          role: "user",
          content: `Classify this cold-email reply as exactly one word: positive (interested, wants a call, asks for info), neutral (auto-reply, OOO, ambiguous), or negative (not interested, unsubscribe, hostile).\n\nReply:\n"""${body.slice(0, 1500)}"""\n\nAnswer with one word only.`
        }]
      })
    }, { retries: 2 });
    const data = await res.json() as { content?: Array<{ type: string; text?: string }> };
    const word = (data.content?.find(b => b.type === "text")?.text ?? "").trim().toLowerCase();
    const sentiment: Sentiment = word.startsWith("pos") ? "positive" : word.startsWith("neg") ? "negative" : "neutral";
    await q(`insert into reply_classifications (message_hash, sentiment, model)
             values ($1,$2,$3) on conflict (message_hash) do nothing`,
      [hash, sentiment, config.classifierModel]);
    return sentiment;
  } catch (e) {
    console.error("classifier error:", (e as Error).message);
    return null;
  }
}
