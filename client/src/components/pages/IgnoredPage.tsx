// Ignored page (Task 5, UX overhaul): every ignore/ignoreDependencies/
// ignoreBinaries entry in the project's knip config, grouped by kind, each
// with a per-entry Remove action (RemoveIgnoreDialog: preview -> diff ->
// apply, same server-backed preview/apply pipeline the fix/ignore flow
// uses). Server-backed (GET /api/ignores — src/ignore/config-writer.ts's
// listIgnores) rather than derived from the scan report: knip's config is
// the source of truth for what's ignored, independent of whatever the
// current scan scope would re-surface as an issue.
import { useState } from 'react';
import type { ComponentType } from 'react';
import { CircleOff, FileCode2 } from 'lucide-react';
import type { IgnoreEntry } from '../../api.js';
import { useIgnores } from '../../state/queries.js';
import { RemoveIgnoreDialog } from '../flows/RemoveIgnoreDialog.js';
import { Button } from '../ui/button.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table.js';

const KIND_LABELS: Record<IgnoreEntry['kind'], string> = {
  ignore: 'Ignored files',
  ignoreDependencies: 'Ignored dependencies',
  ignoreBinaries: 'Ignored binaries',
};

const KIND_ORDER: IgnoreEntry['kind'][] = ['ignore', 'ignoreDependencies', 'ignoreBinaries'];

interface KindGroup {
  kind: IgnoreEntry['kind'];
  entries: IgnoreEntry[];
}

function groupByKind(entries: IgnoreEntry[]): KindGroup[] {
  return KIND_ORDER.map((kind) => ({ kind, entries: entries.filter((e) => e.kind === kind) })).filter(
    (g) => g.entries.length > 0,
  );
}

function EmptyState({
  icon: Icon,
  title,
  detail,
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  detail: string;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
      <Icon className="size-8 text-muted-foreground" aria-hidden="true" />
      <p className="text-sm font-medium">{title}</p>
      <p className="max-w-sm text-xs text-muted-foreground">{detail}</p>
    </div>
  );
}

export function IgnoredPage() {
  const { data, isLoading, error } = useIgnores();
  const [removeEntry, setRemoveEntry] = useState<IgnoreEntry | null>(null);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-4">
      <div className="mb-1 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Ignored</h2>
        {data?.configPath && (
          <span className="truncate font-mono text-xs text-muted-foreground" title={data.configPath}>
            {data.configPath}
          </span>
        )}
      </div>
      <p className="mb-3 text-xs text-muted-foreground">
        @public-tagged exports aren&apos;t listed yet — that needs a repo-wide scan.
      </p>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading ignore list…</p>
      ) : error ? (
        <p className="text-sm text-destructive">
          Failed to load ignore entries: {error instanceof Error ? error.message : String(error)}
        </p>
      ) : !data ? null : data.configKind === 'none' ? (
        <EmptyState
          icon={CircleOff}
          title="No ignore config found"
          detail="Add a knip.json (or a `knip` field in package.json) to start ignoring files, dependencies, or binaries."
        />
      ) : data.configKind === 'code' ? (
        <EmptyState
          icon={FileCode2}
          title="Config is a code file"
          detail={`${data.configPath} can't be edited automatically, so ignore entries defined there aren't listed here.`}
        />
      ) : data.entries.length === 0 ? (
        <EmptyState
          icon={CircleOff}
          title="Nothing is ignored yet"
          detail="Entries you ignore from Code or Packages will show up here."
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-auto" data-testid="ignored-scroll">
          <div className="flex flex-col gap-6 pb-2">
            {groupByKind(data.entries).map((group) => (
              <section key={group.kind} data-testid={`ignored-group-${group.kind}`}>
                <h3 className="mb-1.5 text-xs font-medium text-muted-foreground">{KIND_LABELS[group.kind]}</h3>
                <div className="overflow-hidden rounded-md border border-border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Value</TableHead>
                        <TableHead>Workspace</TableHead>
                        <TableHead className="w-28 text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {group.entries.map((entry) => (
                        <TableRow
                          key={`${entry.kind}:${entry.workspace}:${entry.value}`}
                          data-testid={`ignored-row-${entry.value}`}
                        >
                          <TableCell className="font-mono text-xs">{entry.value}</TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {!entry.workspace || entry.workspace === '.' ? '(root)' : entry.workspace}
                          </TableCell>
                          <TableCell className="text-right">
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              data-testid={`ignored-remove-${entry.value}`}
                              onClick={() => setRemoveEntry(entry)}
                            >
                              Remove
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </section>
            ))}
          </div>
        </div>
      )}

      <RemoveIgnoreDialog
        entry={removeEntry}
        onOpenChange={(open) => {
          if (!open) setRemoveEntry(null);
        }}
      />
    </div>
  );
}
