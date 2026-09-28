/** Frozen 0.4.16 acceptance predicate for the private, zero-transport A/B audit.
 * Keep separate from the current syntax classifier; this is not a second engine. */
export function legacyUserRegexp(pattern: string, flags: string): RegExp | null {
  if (pattern.length > 256 || !/^[img]*$/.test(flags) || new Set(flags).size !== flags.length) return null;
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === '\\') {
      const next = pattern[++i];
      if (!next || /[1-9kpPuUc]/.test(next)) return null;
      continue;
    }
    if (char === '[' && !inClass) { inClass = true; continue; }
    if (char === ']' && inClass) { inClass = false; continue; }
    if (!inClass && /[()*+?{}|]/.test(char)) return null;
  }
  if (inClass) return null;
  try { return new RegExp(pattern, flags); } catch { return null; }
}
