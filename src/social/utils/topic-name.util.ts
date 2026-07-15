/**
 * Topic rows are stored under a lowercased name, so every lookup has to fold the
 * caller's input the same way the writer did — otherwise `/topics/name/ПРИВЕТ`
 * misses the row stored as `привет`.
 *
 * `toLowerCase()` is Unicode-aware, so this covers Cyrillic as well as Latin.
 * Chinese and Arabic are caseless and pass through unchanged.
 */
export function normalizeTopicName(name: string): string {
  return name.trim().toLowerCase();
}
