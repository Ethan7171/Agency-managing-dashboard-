const req = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`Missing required env var: ${k}`);
  return v;
};

export const config = {
  databaseUrl: () => req("DATABASE_URL"),
  masterKey: () => {
    const k = req("MASTER_KEY");
    if (!/^[0-9a-f]{64}$/i.test(k)) throw new Error("MASTER_KEY must be 64 hex chars (32 bytes)");
    return Buffer.from(k, "hex");
  },
  adminPassword: () => req("ADMIN_PASSWORD"),
  appBaseUrl: process.env.APP_BASE_URL ?? "http://localhost:3000",
  closeApiKey: process.env.CLOSE_API_KEY ?? "",
  closeAgencyField: process.env.CLOSE_AGENCY_FIELD ?? "outbound_agency",
  slackBotToken: process.env.SLACK_BOT_TOKEN ?? "",
  slackWebhookUrl: process.env.SLACK_WEBHOOK_URL ?? "",
  slackDefaultChannel: process.env.SLACK_DEFAULT_CHANNEL ?? "",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  classifierDailyCap: Number(process.env.CLASSIFIER_DAILY_CAP ?? 500),
  classifierModel: process.env.CLASSIFIER_MODEL ?? "claude-haiku-4-5-20251001",
  demoMode: (process.env.DEMO_MODE ?? "false").toLowerCase() === "true",
  backfillDays: Math.min(90, Math.max(30, Number(process.env.BACKFILL_DAYS ?? 60))),
  syncCron: process.env.SYNC_CRON ?? "*/30 * * * *",
  port: Number(process.env.PORT ?? 3000)
};
