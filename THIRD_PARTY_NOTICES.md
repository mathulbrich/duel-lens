# Third-party notices

**Duel Lens 0.9.0** · prepared 2026-09-29

<!--
Maintainers: this file was compiled on 2026-09-29 from the build inputs, not from memory:
- the esbuild metafile of build.mjs's entry points (which npm packages end up in which bundle, and how many bytes);
- dist/ as built on 2026-09-29 at 00:08 (the interim build without the earlier prototype's models);
- package-lock.json versions, each package's LICENSE file, and the upstream licence files at the exact versions pinned by
  ONNX Runtime 1.30.0 (cmake/deps.txt).
Re-checked on 2026-09-29 at 05:30 and 06:00 against store builds (node build.mjs --out <scratch folder>: 31 files, 74.0 MB):
- every file in it is covered;
- the npm packages each bundle names in its "// node_modules/…" comments match section 1: background.js has
  @anthropic-ai/sdk (with internal/qs and _vendor/partial-json-parser), standardwebhooks, @stablelib/base64 and
  fast-sha256; offscreen.js has onnxruntime-web (and, until A4, @techstark/opencv-js); content.js, options.js, sidepanel.js,
  welcome.js and legal.js (the new privacy.html and licenses.html pages) have preact;
- the versions match node_modules.
Re-check it before every release and whenever a dependency, the model, the fonts or the card data changes:
docs/release/legal-audit.md, section 14, has the commands (add the legal entry, src/legal/index.tsx, to its list).
build.mjs copies this file into every build without these comments, and licenses.html shows it. The same text goes into
every build, so it describes the store build, which shows YGOPRODeck's card images (decision D2): 2.5 says how the crop
build (--no-remote-images) differs.
The first paragraph below points to Duel Lens's own LICENSE (Apache-2.0, decision D1). build.mjs copies it from the
repository root into every build, and npm run release refuses a build without it.
The earlier prototype's third-party detector and classifier (AGPL-3.0) are not listed: since A6 (a6-phase2-report.md)
none of their code or models is in the repository or in any build, and npm run release refuses a build that contains them.
If any ever ships again, this file is incomplete and the extension can't be published under a non-AGPL licence.
Updated 2026-09-29 for A4 (a4-report.md), against a store build (node build.mjs --out <scratch folder>: 32 files, 62.5 MB):
- Duel Lens's own card detector ships (models/detector/card-detector.onnx, 2.2): build.mjs copies it into every build but
  a --no-detector one, and npm run release refuses a build without it;
- OpenCV.js no longer ships: the card detector replaced it, @techstark/opencv-js is gone from package.json, and npm run
  release refuses a bundle that contains it. Its section (the old 5) is removed and sections 6 to 9 are now 5 to 8;
- offscreen.js's only npm package is onnxruntime-web (its bundle, with Emscripten's JavaScript loader); the LLVM and musl
  code is in ort/ort-wasm-simd-threaded.wasm alone.
Updated 2026-09-30: the embedder is now dinov2-small-duel-v3b (2.1): dinov2-small-duel further fine-tuned on card crops
from public tournament videos (cards only: .superpowers/sdd/2026-09-28-duel-lens-v1/overnight-plan.md), with its own
index (2.3). Same base model, licence and size.
Updated 2026-09-30 (ALT-ART, .superpowers/sdd/2026-09-28-duel-lens-v1/altart-report.md): the index (2.3) also holds 267
vectors of card artworks YGOPRODeck has no image of, computed at build time from Konami's card renders as mirrored by
ygoresources (tools/fetch-alt-artworks.ts, tools/add-alt-artworks.ts). Vectors only: no render ships, and nothing changes
at runtime (no new host, permission or request). Re-count 2.3 whenever the index is rebuilt or the extras refreshed.
-->

Duel Lens is an unofficial, fan-made browser extension. It contains software, a machine-learning model, fonts and data made by others. This file lists every third-party component in the Duel Lens package, the licence it is under, and the notices that licence asks us to pass on to you.

Duel Lens's own code is licensed under the terms in the `LICENSE` file that comes with it. That licence does not cover the third-party components below, and it does not cover Konami's cards, card text or card artwork.

**Contents**

1. [Summary](#1-summary)
2. [Models and data](#2-models-and-data)
3. [JavaScript libraries](#3-javascript-libraries)
4. [WebAssembly: ONNX Runtime Web](#4-webassembly-onnx-runtime-web)
5. [Emscripten runtime, musl and LLVM (in ONNX Runtime Web)](#5-emscripten-runtime-musl-and-llvm-in-onnx-runtime-web)
6. [Fonts](#6-fonts)
7. [Trademarks](#7-trademarks)
8. [Licence texts](#8-licence-texts)

## 1. Summary

| Component | Version | Where in the package | Licence |
|---|---|---|---|
| Duel Lens card-artwork embedder, fine-tuned from DINOv2 ViT-S/14 (`facebook/dinov2-small`) | `dinov2-small-duel-v3b`, 8-bit weights | `models/dinov2-small-duel-v3b.q8.onnx` | Apache-2.0 |
| Duel Lens card detector, on a MobileNetV3-Large backbone fine-tuned from `timm/mobilenetv3_large_100.ra_in1k` | `card-detector`, 16-bit weights | `models/detector/card-detector.onnx` | Apache-2.0 |
| Card artwork index | built 2026-09-30 | `data/index-dinov2-small-duel-v3b.bin`, `data/index-dinov2-small-duel-v3b.meta.json` | See 2.3 (derived from artwork © Konami) |
| Card data from the YGOPRODeck API | database version 147.20 | `data/cards.json` | See 2.4 (card names and text © Konami; not open-licensed) |
| Preact | 10.29.8 | `content.js`, `options.js`, `sidepanel.js`, `welcome.js`, `legal.js` | MIT |
| Anthropic TypeScript SDK (`@anthropic-ai/sdk`) | 0.128.0 | `background.js` | MIT |
| ↳ qs (vendored in the SDK) | — | `background.js` | BSD-3-Clause |
| ↳ partial-json-parser (vendored in the SDK) | 1.2.2 | `background.js` | ISC |
| standardwebhooks | 1.1.1 | `background.js` | MIT |
| @stablelib/base64 | 1.0.1 | `background.js` | MIT |
| fast-sha256 | 1.3.0 | `background.js` | Unlicense (public domain) |
| ONNX Runtime Web | 1.30.0 | `offscreen.js`, `ort/ort-wasm-simd-threaded.mjs`, `ort/ort-wasm-simd-threaded.wasm` | MIT |
| ↳ ONNX | 1.22.0 | `ort/ort-wasm-simd-threaded.wasm` | Apache-2.0 |
| ↳ Protocol Buffers | 33.6 | `ort/ort-wasm-simd-threaded.wasm` | BSD-3-Clause |
| ↳ RE2 | 2024-07-02 | `ort/ort-wasm-simd-threaded.wasm` | BSD-3-Clause |
| ↳ Abseil | 20250814.0 | `ort/ort-wasm-simd-threaded.wasm` | Apache-2.0 |
| ↳ FlatBuffers | 23.5.26 | `ort/ort-wasm-simd-threaded.wasm` | Apache-2.0 |
| ↳ Eigen | commit `1d8b82b0` | `ort/ort-wasm-simd-threaded.wasm` | MPL-2.0 |
| ↳ Guidelines Support Library (Microsoft GSL) | 4.2.1 | `ort/ort-wasm-simd-threaded.wasm` | MIT |
| ↳ JSON for Modern C++ (nlohmann/json) | 3.11.3 | `ort/ort-wasm-simd-threaded.wasm` | MIT |
| ↳ SafeInt | 3.0.28 | `ort/ort-wasm-simd-threaded.wasm` | MIT |
| ↳ date (Howard Hinnant) | 3.0.1 | `ort/ort-wasm-simd-threaded.wasm` | MIT |
| ↳ Boost.Mp11 | 1.82.0 | `ort/ort-wasm-simd-threaded.wasm` | BSL-1.0 |
| Emscripten runtime and musl libc | — | `offscreen.js`, `ort/*` | MIT (Emscripten: MIT or NCSA) |
| LLVM libc++, libc++abi and compiler-rt | — | `ort/ort-wasm-simd-threaded.wasm` | Apache-2.0 WITH LLVM-exception |
| Archivo | Google Fonts, Latin subset | `fonts/archivo-latin-var.woff2` | OFL-1.1 |
| Spectral SC | Google Fonts, Latin subset | `fonts/spectral-sc-latin-700.woff2` | OFL-1.1 |
| Source Serif 4 | Google Fonts, Latin subset | `fonts/source-serif-4-latin-var.woff2`, `fonts/source-serif-4-latin-var-italic.woff2` | OFL-1.1 |
| JetBrains Mono | Google Fonts, Latin subset | `fonts/jetbrains-mono-latin-var.woff2` | OFL-1.1 |

Card images are not part of the package: see 2.5.

## 2. Models and data

### 2.1 Card-artwork embedder: `models/dinov2-small-duel-v3b.q8.onnx`

- **Based on** DINOv2 ViT-S/14, published as `facebook/dinov2-small` (<https://huggingface.co/facebook/dinov2-small>; code and weights: <https://github.com/facebookresearch/dinov2>). Copyright (c) Meta Platforms, Inc. and affiliates. Licensed under the Apache License, Version 2.0 (full text in [8.1](#81-apache-license-20)). DINOv2 is described in Oquab et al., "DINOv2: Learning Robust Visual Features without Supervision", arXiv:2304.07193 (2023).
- **Architecture** as implemented in Hugging Face Transformers (`modeling_dinov2.py`), Copyright 2023 Meta AI and The HuggingFace Inc. team, Apache License 2.0. The model file holds the traced network and its weights, not Transformers' source code.
- **Changes made by the Duel Lens authors** (Apache-2.0, section 4(b)), September 2026: the weights of transformer blocks 4 to 11 and of the final layer norm were fine-tuned to match Yu-Gi-Oh! card artwork as it appears in duel videos, first on renderings of the artwork and then also on card crops from tournament videos (see Training data); a per-image standardisation of each colour channel was added at the input; the output is the final-norm CLS token; the network was exported to ONNX and its matrix weights were quantised to 8 bits (MatMulNBits).
- **Licence:** the fine-tuned model is distributed under the Apache License, Version 2.0.
- **Training data:** renderings of Yu-Gi-Oh! card artwork and card images obtained from YGOPRODeck (<https://ygoprodeck.com/>), and images of single cards cut from frames of publicly available Yu-Gi-Oh! tournament videos (each image shows one card, cut tightly around it; no full frame was kept, and images showing people were removed). That artwork is © Studio Dice/SHUEISHA, TV TOKYO, KONAMI. The model does not contain the images, and its licence grants no rights in Konami's artwork.

### 2.2 Card detector: `models/detector/card-detector.onnx`

- **Made by the Duel Lens authors,** September 2026: a detector that finds the cards on a screenshot, each card's four corners, and whether it lies face up or face down. Its network is a CenterNet-style oriented-box detector (a feature-pyramid neck and detection heads of the project's own design) on a MobileNetV3-Large backbone.
- **Backbone weights:** `timm/mobilenetv3_large_100.ra_in1k` from PyTorch Image Models (timm) (<https://huggingface.co/timm/mobilenetv3_large_100.ra_in1k>; code: <https://github.com/huggingface/pytorch-image-models>). Copyright 2019 Ross Wightman. Licensed under the Apache License, Version 2.0 ([8.1](#81-apache-license-20)). MobileNetV3 is described in Howard et al., "Searching for MobileNetV3", ICCV 2019 (arXiv:1905.02244). The model file holds the traced network and its weights, not timm's source code.
- **ImageNet:** those backbone weights were pretrained on ImageNet-1k (ILSVRC 2012). ImageNet's images come with their own terms of access (non-commercial research and education), as for any ImageNet-pretrained checkpoint. The model contains none of those images.
- **Changes made by the Duel Lens authors** (Apache-2.0, section 4(b)), September 2026: the backbone was fine-tuned together with the new neck and heads to find cards in duel videos; the network was exported to ONNX and its weights were stored as 16-bit floats.
- **Licence:** the card detector is distributed under the Apache License, Version 2.0.
- **Training data:** synthetic duel-stream frames only, rendered by the Duel Lens authors from YGOPRODeck card images and card artwork (© Studio Dice/SHUEISHA, TV TOKYO, KONAMI) and the official card back. No video frame was used for training. The model does not contain the images, and its licence grants no rights in Konami's artwork.

### 2.3 Card artwork index: `data/index-dinov2-small-duel-v3b.bin` and `data/index-dinov2-small-duel-v3b.meta.json`

- 14,894 vectors of 384 numbers (8-bit), computed by the model in 2.1:
  - 14,626 from YGOPRODeck's artwork crops (`images.ygoprodeck.com/images/cards_cropped/`; where no crop exists, from the artwork area of the full card image), one per card artwork;
  - 267 from Konami's own card renders (the artwork area of each), for artworks of 234 cards that YGOPRODeck has no image of. The renders were downloaded once, when the index was built, from YGOResources (`ygoresources.com`), a fan site that mirrors Konami's official card data. Duel Lens includes none of them and never contacts that site;
  - one from the English card back (Yugipedia's file `Back-EN.png`).
- The `.meta.json` file lists the YGOPRODeck card and image ids of the vectors. For the 267 from Konami's renders, it also lists Konami's card id and artwork number, and their image ids are negative numbers made up by Duel Lens, since YGOPRODeck has no image of them.
- No image is included. The artwork the vectors were computed from is © Studio Dice/SHUEISHA, TV TOKYO, KONAMI.

### 2.4 Card data: `data/cards.json`

- 14,590 cards (YGOPRODeck card database version 147.20, downloaded 2026-09-28) from the YGOPRODeck API (<https://ygoprodeck.com/api-guide/>), trimmed to what Duel Lens displays: name, card text, card type, attribute, level/rank/link rating, ATK/DEF, Pendulum scale, archetype, banlist status, and the YGOPRODeck and Konami ids.
- Card names, card text and other game information are © Studio Dice/SHUEISHA, TV TOKYO, KONAMI. The compilation is YGOPRODeck's. Duel Lens includes a copy so that it works offline and calls the API rarely, as YGOPRODeck asks. This data is not covered by Duel Lens's licence.
- Thanks to YGOPRODeck for the Yu-Gi-Oh! API.

### 2.5 Card images (not in the package)

<!-- Maintainers: updated 2026-09-30 for decision D2 (2026-09-29, docs/release/legal-audit.md, "Status update, 2026-09-29 around 10:35"): every build, the store build included, shows YGOPRODeck's official card images (build.mjs: remote images unless --no-remote-images), keeps at most 1,500 of them cached (src/background/image-cache.ts MAX_CACHED_IMAGES), and downloads new cards' artwork for the self-updating index. The crop build (--no-remote-images, the one-flag rollback) downloads neither and shows the user's own crop. If card images are ever re-hosted, name that host instead, and update 2.4 if the card data moves too (D3). -->

- Card images are not included in the package. Duel Lens, the Chrome Web Store version included, downloads the picture of a card from YGOPRODeck's image server (`images.ygoprodeck.com`) the first time it shows you that card, and keeps it in the browser's cache on your computer (the 1,500 most recent).
- When new cards are released, Duel Lens also downloads their artwork from the same server and turns it into numbers on your computer (the artwork index, 2.3); it doesn't keep the images.
- A version of Duel Lens built without card images (the crop build) downloads neither: the picture it shows beside a card is the part of your screen you selected.
- Those images are © Studio Dice/SHUEISHA, TV TOKYO, KONAMI.

## 3. JavaScript libraries

These are bundled into Duel Lens's JavaScript files by esbuild.

### 3.1 Preact

- Version 10.29.8 · <https://preactjs.com/> · <https://github.com/preactjs/preact>
- In `content.js`, `options.js`, `sidepanel.js`, `welcome.js` and `legal.js` (the privacy and licences pages). Licence: MIT.

```text
The MIT License (MIT)

Copyright (c) 2015-present Jason Miller

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### 3.2 Anthropic TypeScript SDK (`@anthropic-ai/sdk`)

- Version 0.128.0 · <https://github.com/anthropics/anthropic-sdk-typescript>
- In `background.js` (used only for the optional AI check). Licence: MIT.

```text
Copyright 2023 Anthropic, PBC.

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

#### qs (vendored in the Anthropic SDK as `internal/qs`)

- From neoqs / qs (<https://github.com/puruvj/neoqs>). Licence: BSD-3-Clause.

```text
BSD 3-Clause License

Copyright (c) 2014, Nathan LaFreniere and other [contributors](https://github.com/puruvj/neoqs/graphs/contributors) All rights reserved.

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

#### partial-json-parser (vendored in the Anthropic SDK as `_vendor/partial-json-parser`)

- From the npm package `partial-json-parser` 1.2.2 (<https://www.npmjs.com/package/partial-json-parser>), whose metadata gives the licence as ISC and the author as "gov". The package publishes no licence file or copyright year; the standard ISC text follows.

```text
ISC License

Copyright (c) gov (author of the partial-json-parser npm package; no year published)

Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

### 3.3 standardwebhooks

- Version 1.1.1 · <https://github.com/standard-webhooks/standard-webhooks> (the JavaScript library; a dependency of the Anthropic SDK)
- In `background.js`. Licence: MIT (the libraries' licence, `libraries/LICENSE` in the repository).

```text
The MIT License

Copyright (c) 2023 Svix (https://www.svix.com)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

### 3.4 @stablelib/base64

- Version 1.0.1 · <https://github.com/StableLib/stablelib/tree/master/packages/base64> (a dependency of standardwebhooks)
- In `background.js`. Licence: MIT.

```text
This software is licensed under the MIT license:

Copyright (C) 2016 Dmitry Chestnykh

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
of the Software, and to permit persons to whom the Software is furnished to do
so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### 3.5 fast-sha256

- Version 1.3.0 · <https://github.com/dchest/fast-sha256-js> (a dependency of standardwebhooks)
- In `background.js`. Licence: Unlicense (public domain dedication).

```text
This is free and unencumbered software released into the public domain.

Anyone is free to copy, modify, publish, use, compile, sell, or
distribute this software, either in source code form or as a compiled
binary, for any purpose, commercial or non-commercial, and by any
means.

In jurisdictions that recognize copyright laws, the author or authors
of this software dedicate any and all copyright interest in the
software to the public domain. We make this dedication for the benefit
of the public at large and to the detriment of our heirs and
successors. We intend this dedication to be an overt act of
relinquishment in perpetuity of all present and future rights to this
software under copyright law.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS BE LIABLE FOR ANY CLAIM, DAMAGES OR
OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE,
ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
OTHER DEALINGS IN THE SOFTWARE.

For more information, please refer to <http://unlicense.org>
```

## 4. WebAssembly: ONNX Runtime Web

- ONNX Runtime Web 1.30.0 · <https://github.com/microsoft/onnxruntime> · npm package `onnxruntime-web`
- Its JavaScript API is bundled into `offscreen.js`; its WebAssembly runtime is `ort/ort-wasm-simd-threaded.wasm`, loaded by `ort/ort-wasm-simd-threaded.mjs`. Licence: MIT.

```text
MIT License

Copyright (c) Microsoft Corporation

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

The WebAssembly runtime contains the third-party components below. They were identified from the binary itself and from the dependency versions ONNX Runtime 1.30.0 pins (`cmake/deps.txt`). Microsoft's complete notice file, which also covers components used only by other ONNX Runtime builds, is at <https://github.com/microsoft/onnxruntime/blob/v1.30.0/ThirdPartyNotices.txt>.

### 4.1 ONNX

- Version 1.22.0 · <https://github.com/onnx/onnx> · Copyright (c) ONNX Project Contributors. Licence: Apache License 2.0 ([8.1](#81-apache-license-20)).
- From ONNX's NOTICE file: "ONNX is licensed under the Apache License, Version 2.0 (see LICENSE)." (The rest of that NOTICE file concerns ONNX's Python wheels, which are not included.)

### 4.2 Protocol Buffers

- Version 33.6 · <https://github.com/protocolbuffers/protobuf>. Licence: BSD-3-Clause.

```text
Copyright 2008 Google Inc.  All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

    * Redistributions of source code must retain the above copyright
notice, this list of conditions and the following disclaimer.
    * Redistributions in binary form must reproduce the above
copyright notice, this list of conditions and the following disclaimer
in the documentation and/or other materials provided with the
distribution.
    * Neither the name of Google Inc. nor the names of its
contributors may be used to endorse or promote products derived from
this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

Code generated by the Protocol Buffer compiler is owned by the owner
of the input file used when generating it.  This code is not
standalone and requires a support library to be linked with it.  This
support library is itself covered by the above license.
```

### 4.3 RE2

- Version 2024-07-02 · <https://github.com/google/re2>. Licence: BSD-3-Clause.

```text
Copyright (c) 2009 The RE2 Authors. All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

   * Redistributions of source code must retain the above copyright
notice, this list of conditions and the following disclaimer.
   * Redistributions in binary form must reproduce the above
copyright notice, this list of conditions and the following disclaimer
in the documentation and/or other materials provided with the
distribution.
   * Neither the name of Google Inc. nor the names of its
contributors may be used to endorse or promote products derived from
this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### 4.4 Abseil

- Version 20250814.0 · <https://github.com/abseil/abseil-cpp> · Copyright 2017 The Abseil Authors. Licence: Apache License 2.0 ([8.1](#81-apache-license-20)).

### 4.5 FlatBuffers

- Version 23.5.26 · <https://github.com/google/flatbuffers> · Copyright 2014 Google Inc. All rights reserved. Licence: Apache License 2.0 ([8.1](#81-apache-license-20)).

### 4.6 Eigen

- <https://eigen.tuxfamily.org/> · Licence: Mozilla Public License 2.0 (<https://mozilla.org/MPL/2.0/>). From Eigen's `COPYING.README`: "Eigen is primarily MPL2 licensed. See COPYING.MPL2 and these links: http://www.mozilla.org/MPL/2.0/ http://www.mozilla.org/MPL/2.0/FAQ.html. Some files contain third-party code under BSD or other MPL2-compatible licenses, whence the other COPYING.* files here."
- **Source code:** ONNX Runtime 1.30.0 builds the Eigen revision `1d8b82b0740839c0de7f1242a3585e3390ff5f33`, available at <https://github.com/eigen-mirror/eigen/tree/1d8b82b0740839c0de7f1242a3585e3390ff5f33> (the project's main repository is <https://gitlab.com/libeigen/eigen>). Eigen's code in the WebAssembly binary is distributed under the MPL 2.0, and nothing in Duel Lens's licence limits your rights to that source code.

### 4.7 Guidelines Support Library (Microsoft GSL)

- Version 4.2.1 · <https://github.com/microsoft/GSL>. Licence: MIT.

```text
Copyright (c) 2015 Microsoft Corporation. All rights reserved.

This code is licensed under the MIT License (MIT).

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
of the Software, and to permit persons to whom the Software is furnished to do
so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

### 4.8 JSON for Modern C++ (nlohmann/json)

- Version 3.11.3 · <https://github.com/nlohmann/json>. Licence: MIT.

```text
MIT License

Copyright (c) 2013-2022 Niels Lohmann

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### 4.9 SafeInt

- Version 3.0.28 · <https://github.com/dcleblanc/SafeInt>. Licence: MIT.

```text
MIT License

Copyright (c) 2018 Microsoft

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### 4.10 date

- Version 3.0.1 · <https://github.com/HowardHinnant/date>. Licence: MIT (the notice in `include/date/date.h`).

```text
The MIT License (MIT)

Copyright (c) 2015, 2016, 2017 Howard Hinnant
Copyright (c) 2016 Adrian Colomitchi
Copyright (c) 2017 Florian Dang
Copyright (c) 2017 Paul Thompson
Copyright (c) 2018, 2019 Tomasz Kamiński
Copyright (c) 2019 Jiangang Zhuang

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### 4.11 Boost.Mp11

- Version 1.82.0 · <https://github.com/boostorg/mp11>. Licence: Boost Software License 1.0 ([8.3](#83-boost-software-license-10)). The BSL does not require a notice for compiled object code; it is listed for completeness.

## 5. Emscripten runtime, musl and LLVM (in ONNX Runtime Web)

ONNX Runtime Web is compiled with Emscripten (<https://emscripten.org/>). Its JavaScript loader (in `offscreen.js` and `ort/ort-wasm-simd-threaded.mjs`) and its WebAssembly code include Emscripten's runtime, parts of the musl C library, and LLVM's C++ runtime libraries.

### 5.1 Emscripten

- <https://github.com/emscripten-core/emscripten>. Licence: MIT or University of Illinois/NCSA (Emscripten's `LICENSE`, which also carries the Node.js notice for code Emscripten adapted from Node.js):

```text
Emscripten is available under 2 licenses, the MIT license and the
University of Illinois/NCSA Open Source License.

Both are permissive open source licenses, with little if any
practical difference between them.

The reason for offering both is that (1) the MIT license is
well-known, while (2) the University of Illinois/NCSA Open Source
License allows Emscripten's code to be integrated upstream into
LLVM, which uses that license, should the opportunity arise.

The full text of both licenses follows.

==============================================================================

Copyright (c) 2010-2014 Emscripten authors, see AUTHORS file.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

==============================================================================

Copyright (c) 2010-2014 Emscripten authors, see AUTHORS file.
All rights reserved.

Permission is hereby granted, free of charge, to any person obtaining a
copy of this software and associated documentation files (the
"Software"), to deal with the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

    Redistributions of source code must retain the above copyright
    notice, this list of conditions and the following disclaimers.

    Redistributions in binary form must reproduce the above
    copyright notice, this list of conditions and the following disclaimers
    in the documentation and/or other materials provided with the
    distribution.

    Neither the names of Mozilla,
    nor the names of its contributors may be used to endorse
    or promote products derived from this Software without specific prior
    written permission.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE CONTRIBUTORS OR COPYRIGHT HOLDERS BE LIABLE FOR
ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS WITH THE SOFTWARE.

==============================================================================

This program uses portions of Node.js source code located in src/library_path.js,
in accordance with the terms of the MIT license. Node's license follows:

    """
        Copyright Joyent, Inc. and other Node contributors. All rights reserved.
        Permission is hereby granted, free of charge, to any person obtaining a copy
        of this software and associated documentation files (the "Software"), to
        deal in the Software without restriction, including without limitation the
        rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
        sell copies of the Software, and to permit persons to whom the Software is
        furnished to do so, subject to the following conditions:

        The above copyright notice and this permission notice shall be included in
        all copies or substantial portions of the Software.

        THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
        IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
        FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
        AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
        LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
        FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
        IN THE SOFTWARE.
    """

The musl libc project is bundled in this repo, and it has the MIT license, see
system/lib/libc/musl/COPYRIGHT

The third_party/ subdirectory contains code with other licenses. None of it is
used by default, but certain options use it (e.g., the optional closure compiler
flag will run closure compiler from third_party/).
```

### 5.2 musl libc

- <https://musl.libc.org/>, as bundled in Emscripten (`system/lib/libc/musl`). Licence: MIT. The full list of musl's authors and contributors is in <https://github.com/emscripten-core/emscripten/blob/main/system/lib/libc/musl/COPYRIGHT>.

```text
musl as a whole is licensed under the following standard MIT license:

----------------------------------------------------------------------
Copyright © 2005-2020 Rich Felker, et al.

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
----------------------------------------------------------------------
```

### 5.3 LLVM libc++, libc++abi and compiler-rt

- <https://llvm.org/>. Licence: Apache License 2.0 with LLVM Exceptions. Under the exception below, the portions compiled into the WebAssembly code may be redistributed without the conditions of sections 4(a), 4(b) and 4(d) of the Apache License; they are listed for completeness.

```text
---- LLVM Exceptions to the Apache 2.0 License ----

As an exception, if, as a result of your compiling your source code, portions
of this Software are embedded into an Object form of such source code, you
may redistribute such embedded portions in such Object form without complying
with the conditions of Sections 4(a), 4(b) and 4(d) of the License.

In addition, if you combine or link compiled forms of this Software with
software that is licensed under the GPLv2 ("Combined Software") and if a
court of competent jurisdiction determines that the patent provision (Section
3), the indemnity provision (Section 9) or other Section of the License
conflicts with the conditions of the GPLv2, you may retroactively and
prospectively choose to deem waived or otherwise exclude such Section(s) of
the License, but only in their entirety and only with respect to the Combined
Software.
```

## 6. Fonts

The fonts are the Latin subsets served by Google Fonts, unmodified. None of them has a Reserved Font Name. They are licensed under the SIL Open Font License, Version 1.1; the licence is in `fonts/OFL.txt` in the package and in [8.2](#82-sil-open-font-license-11).

| Font | Files | Copyright |
|---|---|---|
| Archivo | `fonts/archivo-latin-var.woff2` | Copyright 2020 The Archivo Project Authors (https://github.com/Omnibus-Type/Archivo) |
| Spectral SC | `fonts/spectral-sc-latin-700.woff2` | Copyright 2017 The Spectral Project Authors (https://github.com/productiontype/Spectral) |
| Source Serif 4 | `fonts/source-serif-4-latin-var.woff2`, `fonts/source-serif-4-latin-var-italic.woff2` | Copyright 2014 The Source Serif 4 Project Authors (https://github.com/adobe-fonts/source-serif) |
| JetBrains Mono | `fonts/jetbrains-mono-latin-var.woff2` | Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono) |

## 7. Trademarks

- Yu-Gi-Oh!, KONAMI and the names of Yu-Gi-Oh! cards are trademarks of their respective owners, including Konami and Shueisha.
- YGOPRODeck is the name of the YGOPRODeck website and API. Claude and Anthropic are trademarks of Anthropic, PBC. Chrome is a trademark of Google LLC. ONNX and ONNX Runtime are the names of their projects.
- Duel Lens uses these names only to say what it works with. Duel Lens is not affiliated with, endorsed, sponsored or approved by any of these owners.

## 8. Licence texts

The MIT, BSD, ISC, zlib and Unlicense texts appear with their components above. The longer licences follow.

### 8.1 Apache License 2.0

Applies to: the DINOv2 base model and the Duel Lens embedder (2.1), Hugging Face Transformers' DINOv2 implementation (2.1), the Duel Lens card detector and its MobileNetV3-Large backbone weights from timm (2.2), ONNX (4.1), Abseil (4.4), FlatBuffers (4.5), and, with the LLVM Exceptions, LLVM's runtime libraries (5.3).

```text
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright [yyyy] [name of copyright owner]

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```

### 8.2 SIL Open Font License 1.1

Applies to the fonts in section 6.

```text
-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
```

### 8.3 Boost Software License 1.0

Applies to Boost.Mp11 (4.11).

```text
Boost Software License - Version 1.0 - August 17th, 2003

Permission is hereby granted, free of charge, to any person or organization
obtaining a copy of the software and accompanying documentation covered by
this license (the "Software") to use, reproduce, display, distribute,
execute, and transmit the Software, and to prepare derivative works of the
Software, and to permit third-parties to whom the Software is furnished to
do so, all subject to the following:

The copyright notices in the Software and this entire statement, including
the above license grant, this restriction and the following disclaimer,
must be included in all copies of the Software, in whole or in part, and
all derivative works of the Software, unless such copies or derivative
works are solely in the form of machine-executable object code generated by
a source language processor.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE, TITLE AND NON-INFRINGEMENT. IN NO EVENT
SHALL THE COPYRIGHT HOLDERS OR ANYONE DISTRIBUTING THE SOFTWARE BE LIABLE
FOR ANY DAMAGES OR OTHER LIABILITY, WHETHER IN CONTRACT, TORT OR OTHERWISE,
ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
DEALINGS IN THE SOFTWARE.
```

### 8.4 Mozilla Public License 2.0

Applies to Eigen (4.6). The full text is at <https://mozilla.org/MPL/2.0/> and in Eigen's `COPYING.MPL2` (<https://github.com/eigen-mirror/eigen/blob/1d8b82b0740839c0de7f1242a3585e3390ff5f33/COPYING.MPL2>).
