import { Platform, PlatformAdapter } from "./types.js";
import { smartlead } from "./smartlead.js";
import { instantly } from "./instantly.js";
import { emailbison } from "./emailbison.js";

const registry: Record<Platform, PlatformAdapter> = { smartlead, instantly, emailbison };
export const adapterFor = (p: Platform): PlatformAdapter => registry[p];
export * from "./types.js";
