import fs from 'fs';
import path from 'path';

/**
 * The DWARF files LLDB loads symbols from: every file under Contents/Resources/DWARF of a
 * .dSYM bundle, or the path itself when it already names one such file.
 */
export function dwarfFiles(dsymPath: string): string[] {
  const resolved = path.resolve(dsymPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`dSYM not found: ${resolved}`);
  }
  if (!fs.statSync(resolved).isDirectory()) {
    return [resolved];
  }
  const dwarfDir = path.join(resolved, 'Contents', 'Resources', 'DWARF');
  const files =
    fs.existsSync(dwarfDir) ?
      fs
        .readdirSync(dwarfDir)
        .map((name) => path.join(dwarfDir, name))
        .filter((file) => fs.statSync(file).isFile())
    : [];
  if (files.length === 0) {
    throw new Error(`No DWARF files in ${resolved}; expected a .dSYM bundle with Contents/Resources/DWARF`);
  }
  return files;
}

/**
 * A name the instance accepts for an uploaded DWARF file: ASCII letters, digits, dots,
 * underscores and hyphens, at most 128 characters. LLDB matches symbols by UUID, not by name.
 */
export function remoteDwarfName(localFile: string, index: number): string {
  const safe = path
    .basename(localFile)
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .slice(0, 100);
  return `lldb-symbols-${index}-${safe}.dwarf`;
}
