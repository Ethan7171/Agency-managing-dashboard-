// Worker entrypoint (separate Railway service): pg-boss schedules + handlers.
import { migrate } from "./db/migrate.js";
import { startWorker } from "./jobs/index.js";

migrate()
  .then(startWorker)
  .then(() => console.log("worker running"))
  .catch(e => { console.error("worker startup failed:", e.message); process.exit(1); });
