export function compileIgnorePatterns(patterns?: string[]): ((relativePath: string) => boolean) | undefined {
  if (!patterns || patterns.length === 0) {
    return undefined;
  }

  const regexes = patterns.map((pattern, index) => {
    try {
      return new RegExp(pattern);
    } catch (error) {
      throw new Error(`Invalid ignore regex at index ${index + 1} (${pattern}): ${(error as Error).message}`);
    }
  });

  return (relativePath: string) => regexes.some((regex) => regex.test(relativePath));
}
