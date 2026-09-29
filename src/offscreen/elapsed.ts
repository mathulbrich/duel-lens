/** Milliseconds since `since` (a performance.now() reading), to 0.1 ms. */
export const elapsedMs = (since: number, until = performance.now()) => Math.round((until - since) * 10) / 10;
