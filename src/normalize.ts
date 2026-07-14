/**
 * Normalizes an entity name for use as a DynamoDB sort key segment.
 *
 * - Lowercases
 * - Keeps letters and numbers from ANY language (Unicode-aware via \p{L} and \p{N})
 * - Keeps hyphen and dot; replaces everything else with an underscore
 * - Collapses multiple underscores
 * - Trims leading/trailing underscores
 * - Caps at 80 chars
 */
export function normalize(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}_\-.]/gu, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 80);
}
