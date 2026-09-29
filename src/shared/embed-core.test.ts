import { describe, expect, it } from 'vitest';
import { embedImages, poolOutput, type SessionLike, type TensorLike } from './embed-core';
import type { EmbeddingModelSpec } from './models';
import type { RGBAImage } from './preprocess';

const spec = (pooling: EmbeddingModelSpec['pooling'], maxBatch?: number): EmbeddingModelSpec => ({
  id: 't', label: 't', file: 't.onnx', sourceUrl: '', license: '', inputSize: 2,
  mean: [0, 0, 0], std: [1, 1, 1], inputName: 'pixel_values', outputName: 'out',
  pooling, dim: 2, thresholds: { score: 0.5, margin: 0.05, floor: 0.2 }, maxBatch,
});

class FakeTensor {
  constructor(public type: string, public data: Float32Array, public dims: number[]) {}
}

const white: RGBAImage = { data: new Uint8ClampedArray(2 * 2 * 4).fill(255), width: 2, height: 2 };

describe('poolOutput', () => {
  it("passes [n, dim] through for 'none'", () => {
    const t: TensorLike = { data: new Float32Array([3, 4, 0, 5]), dims: [2, 2] };
    expect(poolOutput(t, 'none', 2).map((v) => Array.from(v))).toEqual([[3, 4], [0, 5]]);
  });
  it("takes token 0 for 'cls'", () => {
    // [n=1, tokens=2, dim=2]
    const t: TensorLike = { data: new Float32Array([1, 2, 9, 9]), dims: [1, 2, 2] };
    expect(Array.from(poolOutput(t, 'cls', 1)[0])).toEqual([1, 2]);
  });
  it("averages tokens for 'mean'", () => {
    const t: TensorLike = { data: new Float32Array([1, 2, 3, 6]), dims: [1, 2, 2] };
    expect(Array.from(poolOutput(t, 'mean', 1)[0])).toEqual([2, 4]);
  });
  it('rejects an output whose batch size is wrong', () => {
    const t: TensorLike = { data: new Float32Array([1, 2]), dims: [1, 2] };
    expect(() => poolOutput(t, 'none', 2)).toThrow(/batch/i);
  });
});

describe('embedImages', () => {
  it('batches images, feeds the named input, and L2-normalises', async () => {
    const calls: number[][] = [];
    const session: SessionLike = {
      async run(feeds) {
        const x = feeds['pixel_values'] as FakeTensor;
        calls.push(x.dims);
        const n = x.dims[0];
        const data = new Float32Array(n * 2);
        for (let i = 0; i < n; i++) data.set([3, 4], i * 2);
        return { out: { data, dims: [n, 2] } };
      },
    };
    const vecs = await embedImages(session, FakeTensor, spec('none'), [white, white, white]);
    expect(calls).toEqual([[3, 3, 2, 2]]);
    expect(vecs).toHaveLength(3);
    expect(vecs[0][0]).toBeCloseTo(0.6, 6);
    expect(vecs[0][1]).toBeCloseTo(0.8, 6);
  });

  it('splits into chunks of maxBatch', async () => {
    const sizes: number[] = [];
    const session: SessionLike = {
      async run(feeds) {
        const n = (feeds['pixel_values'] as FakeTensor).dims[0];
        sizes.push(n);
        return { out: { data: new Float32Array(n * 2).fill(1), dims: [n, 2] } };
      },
    };
    const vecs = await embedImages(session, FakeTensor, spec('none', 2), [white, white, white]);
    expect(sizes).toEqual([2, 1]);
    expect(vecs).toHaveLength(3);
  });

  it('fails clearly when the output name is missing', async () => {
    const session: SessionLike = { async run() { return {}; } };
    await expect(embedImages(session, FakeTensor, spec('none'), [white])).rejects.toThrow(/output "out"/);
  });
});
