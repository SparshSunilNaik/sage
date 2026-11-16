/**
 * Minimal glob matcher (no dependency): supports `**`, `*`, `?` and `{a,b}`.
 * Paths are normalised to forward slashes before matching.
 */
const cache = new Map<string, RegExp>();

export function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

export function globToRegExp(glob: string): RegExp {
  const hit = cache.get(glob);
  if (hit) return hit;
  let re = "";
  const g = toPosix(glob);
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === "*") {
      if (g[i + 1] === "*") {
        const slash = g[i + 2] === "/";
        re += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "{") {
      const end = g.indexOf("}", i);
      if (end === -1) {
        re += "\\{";
      } else {
        re += `(?:${g
          .slice(i + 1, end)
          .split(",")
          .map((s) => s.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"))
          .join("|")})`;
        i = end;
      }
    } else if (".+^$()|[]\\".includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  const out = new RegExp(`^${re}$`, process.platform === "win32" ? "i" : "");
  cache.set(glob, out);
  return out;
}

export function matchesAny(path: string, globs: readonly string[]): boolean {
  const p = toPosix(path);
  return globs.some((g) => globToRegExp(g).test(p));
}
