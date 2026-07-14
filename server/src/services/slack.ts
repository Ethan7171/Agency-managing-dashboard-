// Slack delivery. Prefers a bot token (per-agency channels via chat.postMessage);
// falls back to a single incoming webhook. Both configured via env/Railway
// secrets — never stored in the DB.
import { config } from "../config.js";
import { fetchWithRetry } from "../http.js";

export async function postSlack(text: string, channelId?: string | null): Promise<boolean> {
  try {
    if (config.slackBotToken) {
      const channel = channelId || config.slackDefaultChannel;
      if (!channel) return false;
      await fetchWithRetry("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: { Authorization: `Bearer ${config.slackBotToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ channel, text, unfurl_links: false })
      }, { retries: 2 });
      return true;
    }
    if (config.slackWebhookUrl) {
      await fetchWithRetry(config.slackWebhookUrl, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text })
      }, { retries: 2 });
      return true;
    }
  } catch (e) {
    console.error("slack post failed:", (e as Error).message);
  }
  return false;
}
