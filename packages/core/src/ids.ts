import { randomBytes } from "node:crypto";

/** Sortable, short id: <prefix>-<base36 time><random>. */
export function newId(prefix: string): string {
  const t = Date.now().toString(36).padStart(9, "0");
  const r = randomBytes(4).toString("hex");
  return `${prefix}-${t}${r}`;
}

export function randomToken(bytes = 24): string {
  return randomBytes(bytes).toString("base64url");
}
