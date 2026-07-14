import { q } from "../db/pool.js";

export const audit = (action: string, entity: string, entityId: string | null, detail: unknown = null, actor = "flax_admin") =>
  q(`insert into audit_log (actor, action, entity, entity_id, detail) values ($1,$2,$3,$4,$5)`,
    [actor, action, entity, entityId, detail ? JSON.stringify(detail) : null]);
