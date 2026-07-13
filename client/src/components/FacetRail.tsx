// Left rail nav (see design spec's "Left rail (facets)" bullet): the facet
// list with count badges. Active-facet state is owned by App, not here, so
// the main content area can switch views based on it.
import type { Issue } from '../../../src/core/types.js';
import { FACETS, issuesForFacet, type Facet } from '../lib/facets.js';

export interface FacetRailProps {
  issues: Issue[];
  activeFacet: Facet;
  onSelectFacet: (facet: Facet) => void;
}

export function FacetRail({ issues, activeFacet, onSelectFacet }: FacetRailProps) {
  return (
    <nav
      className="w-56 shrink-0 overflow-y-auto border-r border-gray-200 bg-gray-50 p-2 dark:border-gray-800 dark:bg-gray-900"
      aria-label="Issue facets"
    >
      <ul className="flex flex-col gap-0.5">
        {FACETS.map((facet) => {
          const count = issuesForFacet(facet.id, issues).length;
          const isActive = facet.id === activeFacet;
          return (
            <li key={facet.id}>
              <button
                type="button"
                data-testid={`facet-${facet.id}`}
                aria-current={isActive ? 'page' : undefined}
                onClick={() => onSelectFacet(facet.id)}
                className={`flex w-full items-center justify-between rounded px-2 py-1 text-left text-sm ${
                  isActive
                    ? 'bg-gray-200 font-medium text-gray-900 dark:bg-gray-800 dark:text-gray-100'
                    : 'text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800'
                }`}
              >
                <span>{facet.label}</span>
                <span className="rounded-full bg-gray-200 px-1.5 text-xs tabular-nums text-gray-700 dark:bg-gray-700 dark:text-gray-200">
                  {count}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
