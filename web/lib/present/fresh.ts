/**
 * Lists other people change (decks, the trash, transfers, versions) are read again whenever a page shows them, also
 * when the browser goes back to a page it already had: the first paint comes from the server, then this refetch.
 */
export const ALWAYS_FRESH = { staleTime: 0, refetchOnMount: "always" as const };
