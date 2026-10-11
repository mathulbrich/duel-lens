import { describe, expect, it } from 'vitest';
import { getBanlist, getPriceAsOf, setBanlist, setPriceAsOf } from './prefs';

describe('banlist pref', () => {
  it("defaults to 'tcg'", () => {
    expect(getBanlist()).toBe('tcg');
  });

  it("keeps 'ocg'", () => {
    setBanlist('ocg');
    expect(getBanlist()).toBe('ocg');
    setBanlist('tcg');
  });

  it("reads an unknown or missing value as 'tcg'", () => {
    setBanlist('ocg');
    setBanlist(undefined);
    expect(getBanlist()).toBe('tcg');
    setBanlist('always' as never);
    expect(getBanlist()).toBe('tcg');
  });
});

describe('price-as-of pref', () => {
  it('is undefined until set, and keeps what it is set to', () => {
    expect(getPriceAsOf()).toBeUndefined();
    setPriceAsOf('DB 147.20');
    expect(getPriceAsOf()).toBe('DB 147.20');
    setPriceAsOf(undefined);
    expect(getPriceAsOf()).toBeUndefined();
  });
});
