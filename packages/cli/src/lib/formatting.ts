import Table from 'cli-table3';

export function renderTable(headers: string[], rows: string[][]): string {
  const table = new Table({
    head: headers,
    style: { head: ['cyan'] },
  });
  for (const row of rows) {
    table.push(row);
  }
  return table.toString();
}

export function parseLabels(labels: string[] | undefined): Record<string, string> | undefined {
  if (!labels || labels.length === 0) return undefined;
  const result: Record<string, string> = {};
  for (const l of labels) {
    const eqIdx = l.indexOf('=');
    if (eqIdx > 0) {
      result[l.slice(0, eqIdx)] = l.slice(eqIdx + 1);
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}
