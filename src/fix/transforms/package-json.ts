import { applyEdits, modify, parse } from 'jsonc-parser';
import { detectFormatting } from '../../core/jsonc-format.js';
import type { TransformResult } from './source.js';

export type PackageJsonIssueType = 'dependencies' | 'devDependencies' | 'optionalPeerDependencies';

// knip's `optionalPeerDependencies` issue type does NOT have its own package.json
// key — verified against node_modules/knip/dist/DependencyDeputy.js: it reads the
// `peerDependencies` map and treats an entry as "optional" when
// `peerDependenciesMeta[name].optional` is `true`. So the dependency spec itself
// lives under `peerDependencies`, and removing it must also drop the now-dangling
// `peerDependenciesMeta[name]` entry (present only when the peer was marked optional).
const KEY_BY_ISSUE_TYPE: Record<PackageJsonIssueType, 'dependencies' | 'devDependencies' | 'peerDependencies'> = {
  dependencies: 'dependencies',
  devDependencies: 'devDependencies',
  optionalPeerDependencies: 'peerDependencies',
};

// Removes `depName` from the given section of a package.json document, via
// jsonc-parser's `modify`/`applyEdits` so the rest of the file — formatting,
// key order, any comments (package.json itself has none, but the same code path
// is reused for jsonc-shaped documents elsewhere) — is left byte-for-byte alone.
export function removeDependency(
  content: string,
  depName: string,
  issueType: PackageJsonIssueType,
): TransformResult {
  const key = KEY_BY_ISSUE_TYPE[issueType];
  const pkg = parse(content);
  const section = pkg?.[key];
  // Object.hasOwn, not `in`: a dep literally named `constructor`/`toString`/etc.
  // is inherited from Object.prototype and would spuriously pass `in`, turning a
  // real not-found into a silent ok:true no-op.
  if (section == null || typeof section !== 'object' || !Object.hasOwn(section, depName)) {
    return { ok: false, reason: 'not-found' };
  }

  const formattingOptions = detectFormatting(content);
  let newContent = applyEdits(content, modify(content, [key, depName], undefined, { formattingOptions }));

  if (issueType === 'optionalPeerDependencies') {
    const meta = pkg?.peerDependenciesMeta;
    if (meta != null && typeof meta === 'object' && Object.hasOwn(meta, depName)) {
      newContent = applyEdits(
        newContent,
        modify(newContent, ['peerDependenciesMeta', depName], undefined, { formattingOptions }),
      );
    }
  }

  return { ok: true, newContent };
}
