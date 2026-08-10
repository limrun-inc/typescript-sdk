/**
 * Parses an "x,y" point flag into non-negative coordinates. Empty components
 * are rejected explicitly because Number('') is 0, which would silently turn
 * "200," into [200, 0].
 */
export function parsePointFlag(value: string, flagName: string): [number, number] {
  const parts = value.split(',').map((part) => part.trim());
  const numbers = parts.map((part) => (part === '' ? NaN : Number(part)));
  if (parts.length !== 2 || numbers.some((n) => !Number.isFinite(n) || n < 0)) {
    throw new Error(`${flagName} must be "x,y" with non-negative numbers, e.g. ${flagName} 200,400`);
  }
  return [numbers[0], numbers[1]];
}
