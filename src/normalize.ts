/**
 * Normalizes an entity name for use as a DynamoDB sort key segment.
 *
 * - Lowercases
 * - Replaces non-alphanumeric chars (keeping common symbols like §, -, .)
 * - Collapses multiple underscores
 * - Trims leading/trailing underscores
 * - Caps at 80 chars
 */
export function normalize(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\u00e4\u00f6\u00fc\u00df\u00a7_\-.]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 80);
}
