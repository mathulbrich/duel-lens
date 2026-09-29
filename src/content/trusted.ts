// Real input only (security review M1). isTrusted is true for the browser's own input: the user's
// keys and pointer, and assistive technology's actions. It is false for any event a script made
// (dispatchEvent, element.click()), and a page can't forge it. The page can dispatch keys at window,
// where our key handler listens, and could press our buttons given a reference to them, so none of
// those may drive the overlay (close it, pick a match, copy, keep, or ask the AI on the user's key).

/** Whether the browser made this event for real input. */
export const fromUser = (e: Event): boolean => e.isTrusted === true;

/** `handler`, run for real input only. */
export function byUser<E extends Event>(handler: (e: E) => void): (e: E) => void {
  return (e) => {
    if (fromUser(e)) handler(e);
  };
}
