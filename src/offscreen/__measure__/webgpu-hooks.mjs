// Measurement (not shipped): runs tools/eval-real.ts unchanged with its embedder and card detector on a
// headless Chrome page's WebGPU execution provider (webgpu-ort-node.ts stands in for tools/lib/ort-node.ts
// and src/offscreen/detector/node.ts).
//   node --import tsx --import ./src/offscreen/__measure__/webgpu-hooks.mjs tools/eval-real.ts [its options]
//   BROWSER_ORT_EP=wasm: the page's WASM execution provider instead.
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

const standIn = pathToFileURL(new URL('./webgpu-ort-node.ts', import.meta.url).pathname).href;
registerHooks({
  resolve(specifier, context, next) {
    const fromEvalReal = context.parentURL?.endsWith('/tools/eval-real.ts');
    if (fromEvalReal && (specifier === './lib/ort-node' || specifier === '../src/offscreen/detector/node')) return { url: standIn, shortCircuit: true };
    return next(specifier, context);
  },
});
