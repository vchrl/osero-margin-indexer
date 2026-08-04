/**
 * Minimal .env loader, imported for its side effect at the top of every
 * entrypoint. Zero-dependency on purpose (same reasoning as raw SQL over an
 * ORM): the parse rules we need are five lines, and dotenv's edge cases
 * (multiline, expansion) are edge cases we do not want silently active.
 *
 * Real environment variables always win over .env values.
 */

import { existsSync, readFileSync } from "node:fs";

export function loadEnv(path = ".env"): void {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnv();
