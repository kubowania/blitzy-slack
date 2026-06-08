import { SearchResultsList } from '@/components/search/SearchResultsList';

/**
 * Search results page rendered at the `/app/search` route inside the
 * authenticated workspace shell. The shell's `<SearchBar />` (in the global
 * header) navigates here with the query encoded as the `?q=` search parameter.
 *
 * The page is a thin composition wrapper: it renders a page-level heading band
 * and delegates every aspect of search — reading `?q=` from the URL, fetching
 * `GET /api/search?q=`, grouping results into Messages / Channels / Files tabs,
 * and presenting loading, empty, and error states — to {@link SearchResultsList}.
 * It performs no data fetching, holds no state, and reads no router params.
 *
 * Layout: the page fills the shell's `<main>` (which is `flex-1 overflow-hidden`)
 * as a vertical flex column. The heading band sizes to its content while the
 * results list takes the remaining height. The list receives `min-h-0` so the
 * `ScrollArea` nested inside it can shrink below its content height and scroll
 * rather than overflow the column.
 */
export default function SearchResults() {
  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-border bg-background px-6 py-3">
        <h1 className="text-base font-semibold text-foreground">Search results</h1>
      </header>

      <SearchResultsList className="flex-1 min-h-0 px-6 py-4" />
    </div>
  );
}
