// Real input in unit tests. The overlay ignores events whose isTrusted is false (security review M1:
// a page's own script can dispatch keys at window, or click our buttons given a reference), and
// happy-dom leaves isTrusted undefined on every event. Test-only: nothing in the extension imports this.

/**
 * Makes every event count as real input (isTrusted true), as a user's keys and clicks are in Chrome.
 * Returns the undo; call it in afterEach.
 */
export function trustEvents(): () => void {
  const proto = Event.prototype;
  const before = Object.getOwnPropertyDescriptor(proto, 'isTrusted');
  Object.defineProperty(proto, 'isTrusted', { configurable: true, get: () => true });
  return () => {
    if (before) Object.defineProperty(proto, 'isTrusted', before);
    else delete (proto as { isTrusted?: boolean }).isTrusted;
  };
}

/** The event as a page's script makes it (dispatchEvent, element.click()): isTrusted false. */
export function untrusted<E extends Event>(e: E): E {
  Object.defineProperty(e, 'isTrusted', { value: false });
  return e;
}

/** The event as the browser makes it (the user's input, a real fullscreen change): isTrusted true, even without trustEvents(). */
export function trusted<E extends Event>(e: E): E {
  Object.defineProperty(e, 'isTrusted', { value: true });
  return e;
}
