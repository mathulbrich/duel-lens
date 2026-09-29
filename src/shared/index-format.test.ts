import { describe, expect, it } from 'vitest';
import { decodeIndex, encodeIndexBinary, quantizeInt8, type IndexMeta } from './index-format';

const meta = (quant: 'int8' | 'float32'): IndexMeta => ({
  modelId: 'm', dim: 2, count: 2, quant, builtAt: '2026-09-28T00:00:00Z',
  entries: [{ imageId: 10, cardId: 1 }, { imageId: 20, cardId: 2 }],
});

describe('quantizeInt8', () => {
  it('maps [-1, 1] to [-127, 127], rounding and clamping', () => {
    expect(Array.from(quantizeInt8(new Float32Array([1, -1, 0.5, 2, -0.004])))).toEqual([127, -127, 64, 127, -1]);
  });
});

describe('index binary round-trip', () => {
  it('round-trips int8 vectors', () => {
    const v = new Int8Array([127, 0, -64, 32]);
    const bin = encodeIndexBinary(2, 2, 'int8', v);
    const idx = decodeIndex(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength), meta('int8'));
    expect(idx.vectors).toBeInstanceOf(Int8Array);
    expect(Array.from(idx.vectors)).toEqual([127, 0, -64, 32]);
  });

  it('round-trips float32 vectors', () => {
    const v = new Float32Array([0.5, -0.25, 1, 0]);
    const bin = encodeIndexBinary(2, 2, 'float32', v);
    const idx = decodeIndex(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength), meta('float32'));
    expect(idx.vectors).toBeInstanceOf(Float32Array);
    expect(Array.from(idx.vectors)).toEqual([0.5, -0.25, 1, 0]);
  });

  it('rejects a file with the wrong magic', () => {
    const bin = encodeIndexBinary(2, 2, 'int8', new Int8Array(4));
    bin[0] = 0;
    expect(() => decodeIndex(bin.buffer, meta('int8'))).toThrow(/not a Duel Lens index/i);
  });

  it('rejects metadata that does not match the binary', () => {
    const bin = encodeIndexBinary(2, 2, 'int8', new Int8Array(4));
    expect(() => decodeIndex(bin.buffer, { ...meta('int8'), dim: 3 })).toThrow(/does not match/i);
    expect(() => decodeIndex(bin.buffer, { ...meta('int8'), quant: 'float32' })).toThrow(/does not match/i);
  });

  it('rejects a truncated body', () => {
    const bin = encodeIndexBinary(2, 2, 'int8', new Int8Array(4));
    expect(() => decodeIndex(bin.buffer.slice(0, bin.byteLength - 1), meta('int8'))).toThrow(/truncated/i);
  });
});
