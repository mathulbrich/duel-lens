import { describe, expect, it } from 'vitest';
import { serialWrites } from './writes';

describe("the popup's settings writes", () => {
  it('run one after another in the order asked, a failed one not stopping the next', async () => {
    const queue = serialWrites();
    const order: string[] = [];
    let release!: () => void;
    const slow = queue(() => new Promise<void>((resolve) => (release = () => (order.push('switch'), resolve()))));
    const failing = queue(async () => {
      order.push('speed 1');
      throw new Error('storage');
    });
    const after = queue(async () => void order.push('speed 2'));
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual([]); // nothing passes the slow first write
    release();
    await slow;
    await expect(failing).rejects.toThrow('storage');
    await after;
    expect(order).toEqual(['switch', 'speed 1', 'speed 2']);
  });
});
