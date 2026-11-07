// The popup's settings writes, one after another in the order asked: setSettings reads the stored settings and writes
// them back whole, so two writes at once (the Live check switch and its Speed) could put back what the other changed.
export function serialWrites(): <T>(write: () => Promise<T>) => Promise<T> {
  let last: Promise<unknown> = Promise.resolve();
  return <T>(write: () => Promise<T>) => {
    const next = last.catch(() => undefined).then(write);
    last = next;
    return next;
  };
}
