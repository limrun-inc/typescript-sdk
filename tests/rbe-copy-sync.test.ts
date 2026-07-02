import fs from 'fs';
import path from 'path';

// TEMPORARY drift guard: src/rbe-workspace.ts is the canonical copy of the
// CLI's rbe-workspace module, but the CLI keeps its own copy until it can
// import from a published @limrun/api that contains it (its CI compiles
// against the released package). Until that follow-up deletes the CLI copy,
// this test pins the two byte-identical, so a fix landing on one copy cannot
// silently ship without the other. Delete this file together with
// packages/cli/src/lib/rbe-workspace.ts.
test('the CLI rbe-workspace copy is byte-identical to the SDK canonical copy', () => {
  const read = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
  expect(read('packages/cli/src/lib/rbe-workspace.ts')).toBe(read('src/rbe-workspace.ts'));
});
