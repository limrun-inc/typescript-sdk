/**
 * Best-effort open of a URL in the user's default browser. Returns false
 * instead of throwing when the browser cannot be launched (e.g. headless
 * environments), so callers can fall back to just printing the URL.
 */
export async function openInBrowser(url: string): Promise<boolean> {
  try {
    // Dynamic ESM import because `open` is ESM-only and the CLI compiles to CJS.
    const importEsm = new Function('specifier', 'return import(specifier)') as (
      specifier: string,
    ) => Promise<typeof import('open')>;
    const { default: open } = await importEsm('open');
    await open(url);
    return true;
  } catch {
    return false;
  }
}
