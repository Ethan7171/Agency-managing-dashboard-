// API entrypoint. Serves the built React app + the /api surface.
// All third-party calls happen behind this server; the frontend never sees a key.
import express from "express";
import cookieParser from "cookie-parser";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "./db/migrate.js";
import { api } from "./routes/api.js";
import { config } from "./config.js";
import { redact } from "./http.js";

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

// Never let a secret hit the logs, even via error paths.
app.use((req, _res, next) => { console.log(`${req.method} ${redact(req.originalUrl)}`); next(); });

app.use("/api", api);

const webDist = join(dirname(fileURLToPath(import.meta.url)), "../../web/dist");
if (existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(join(webDist, "index.html")));
}

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(redact(err.message));
  res.status(500).json({ error: "internal error" });
});

migrate()
  .then(() => app.listen(config.port, "0.0.0.0", () =>
    console.log(`api listening on 0.0.0.0:${config.port} ${config.demoMode ? "(DEMO MODE)" : ""}`)))
  .catch(e => { console.error("startup failed:", e.message); process.exit(1); });
