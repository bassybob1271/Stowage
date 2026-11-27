/** Outbound calls to Bazzy TV. Swappable for tests. */
export const bazzyHttp = { fetch: (input: string, init?: RequestInit) => fetch(input, init) };
