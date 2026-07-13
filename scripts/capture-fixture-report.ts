import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const fixture = new URL('../tests/fixtures/single/', import.meta.url).pathname;
// knip's package.json "exports" map doesn't expose "./bin/knip.js" or "./package.json"
// as subpaths, so require.resolve('knip/bin/knip.js', ...) fails under Node's ESM-aware
// resolution. Resolve the package's main entry instead (allowed via the "." export) and
// derive the bin path from its directory, matching the "bin" field in knip/package.json.
const knipMain = require.resolve('knip', { paths: [fixture] });
const knipRoot = dirname(dirname(knipMain)); // .../node_modules/knip/dist/index.js -> .../node_modules/knip
const knipBin = join(knipRoot, 'bin/knip.js');

let stdout = '';
try {
  stdout = execFileSync(process.execPath, [knipBin, '--reporter', 'json'], {
    cwd: fixture,
    encoding: 'utf8',
  });
} catch (e: any) {
  if (e.status === 1 && e.stdout) stdout = e.stdout;
  else throw e;
}
writeFileSync(new URL('../tests/fixtures/single-report.json', import.meta.url), stdout);
console.log(stdout);
