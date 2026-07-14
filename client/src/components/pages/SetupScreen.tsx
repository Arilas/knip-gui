// Setup/error screen (Task 6, UX overhaul): replaces the data-dependent pages
// (Dashboard/Code/Packages) whenever the last scan failed in a way no report
// can recover from on its own — `error.code === 'knip-not-found'` (knip isn't
// resolvable from this project at all) or `error.code === 'knip-failed'` with
// `exitCode >= 2` (knip itself exited fatally: a config it couldn't load or
// parse, or some other non-"issues found" failure — see
// src/core/knip-runner.ts's runScan, which only rejects at exitCode >= 2;
// exitCode 1 just means "knip ran fine and found issues", not a setup
// problem). App.tsx decides which error codes route here; this component just
// renders the help for it — copyable stderr, likely causes picked by code, a
// starter config snippet, a docs link, and Re-run.
import { Copy, ExternalLink, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { apiErrorMessage, type StoreError } from '../../api.js';
import { useScanMutation } from '../../state/queries.js';
import { Button } from '../ui/button.js';

export interface SetupScreenProps {
  error: StoreError;
}

const NOT_FOUND_CAUSES = [
  "knip isn't installed as a dependency of this project — install it with `npm i -D knip` and re-run.",
  "knip is installed somewhere else (a different workspace/node_modules) than the folder knip-gui was pointed at.",
];

const FAILED_CAUSES = [
  'No knip config was found, and the default entry/project patterns didn’t match any files.',
  'The knip config exists but is invalid — malformed JSON, or an entry/project glob that matches nothing.',
  'Something else knip treats as fatal (e.g. an unresolvable workspace or plugin) — see the exact output below.',
];

const STARTER_SNIPPET = `{
  "entry": ["src/index.ts"],
  "project": ["src/**/*.ts"]
}`;

async function copyToClipboard(label: string, text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${label} copied to clipboard`);
  } catch {
    toast.error(`Could not copy ${label.toLowerCase()} — copy it manually`);
  }
}

export function SetupScreen({ error }: SetupScreenProps) {
  const scanMutation = useScanMutation();
  const causes = error.code === 'knip-not-found' ? NOT_FOUND_CAUSES : FAILED_CAUSES;

  async function handleRerun() {
    try {
      await scanMutation.mutateAsync(undefined);
    } catch (e) {
      toast.error(apiErrorMessage(e));
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-6" data-testid="setup-screen">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-5">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold">knip couldn&apos;t scan this project</h2>
          <p className="text-sm text-muted-foreground">
            {error.code === 'knip-not-found'
              ? "knip isn't installed, or couldn't be resolved from this project."
              : `The scan failed${typeof error.exitCode === 'number' ? ` (exit code ${error.exitCode})` : ''}.`}
          </p>
        </div>

        <div>
          <h3 className="mb-1.5 text-xs font-medium text-muted-foreground">Likely causes</h3>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {causes.map((cause) => (
              <li key={cause}>{cause}</li>
            ))}
          </ul>
        </div>

        {error.stderr && (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-xs font-medium text-muted-foreground">knip output</h3>
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="setup-copy-stderr"
                onClick={() => copyToClipboard('Error output', error.stderr!)}
              >
                <Copy className="size-3.5" />
                Copy
              </Button>
            </div>
            <pre
              data-testid="setup-stderr"
              className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted/50 p-3 font-mono text-xs"
            >
              {error.stderr}
            </pre>
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-xs font-medium text-muted-foreground">Starter knip.json</h3>
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="setup-copy-snippet"
              onClick={() => copyToClipboard('knip.json snippet', STARTER_SNIPPET)}
            >
              <Copy className="size-3.5" />
              Copy
            </Button>
          </div>
          <pre
            data-testid="setup-snippet"
            className="overflow-auto rounded-md border border-border bg-muted/50 p-3 font-mono text-xs"
          >
            {STARTER_SNIPPET}
          </pre>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
          <a
            href="https://knip.dev/overview/configuration"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-sm text-primary underline underline-offset-4 hover:text-primary/80"
          >
            Configuration docs
            <ExternalLink className="size-3.5" />
          </a>
          <Button type="button" data-testid="setup-rerun" disabled={scanMutation.isPending} onClick={handleRerun}>
            <RefreshCw className={scanMutation.isPending ? 'size-4 animate-spin' : 'size-4'} />
            {scanMutation.isPending ? 'Scanning…' : 'Re-run'}
          </Button>
        </div>
      </div>
    </div>
  );
}
