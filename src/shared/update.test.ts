import { describe, expect, it } from 'vitest';
import { isNewer, isVersion, noticeFor } from './update';

describe('isNewer', () => {
  it('compares each number, a missing part as 0', () => {
    expect(isNewer('0.9.4', '0.9.3')).toBe(true);
    expect(isNewer('0.10.0', '0.9.9')).toBe(true);
    expect(isNewer('1.0', '0.9.9')).toBe(true);
    expect(isNewer('0.9.3', '0.9.3')).toBe(false);
    expect(isNewer('0.9.3', '0.9.3.0')).toBe(false);
    expect(isNewer('0.9.2', '0.9.10')).toBe(false);
  });
});

describe('noticeFor', () => {
  it('is the stored version while it is newer than this copy, else none', () => {
    expect(noticeFor({ version: '0.9.4' }, '0.9.3')).toEqual({ version: '0.9.4' });
    expect(noticeFor({ version: '0.9.4' }, '0.9.4')).toBeNull(); // the user updated
    expect(noticeFor(undefined, '0.9.3')).toBeNull();
    expect(noticeFor({ version: '<img src=x>' }, '0.9.3')).toBeNull();
    expect(isVersion('v0.9.4')).toBe(false);
  });
});
