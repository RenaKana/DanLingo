# Local WebGPU native build

This is wllama 3.6.1 with llama.cpp commit `83d855c5a6d70487121edbf4020b25c96b7a04e7`, built with Emscripten 4.0.20 and emdawnwebgpu `v20260317.182325`. The source change is in [native-policy.patch](native-policy.patch): set `common_params.cache_ram_mib = 0` before loading the model.

The host prompt snapshot cache copies GPU KV state into host RAM when a reused slot loses much of its prompt. On the measured browser this blocked global decoding for seconds. Disabling those snapshots preserves live unified KV, continuous batching and per-request prompt reuse. The extension's translation cache and deduplication are separate.

`wllama.js`, `wllama.wasm` and `source-map.json` form one build. [build-info.json](build-info.json) records their hashes and pinned inputs. The Vite plugin verifies all three and fails on a mismatch. It uses this symbol map instead of the published binary's map. The rebuilt Emscripten JavaScript is byte-identical to the published wrapper.

Run `node scripts/build-local-native.mjs` from the project root to reproduce the build in a fresh artifact directory. Docker must already be running with the exact image from `build-info.json` installed. The script verifies cached source archives or downloads the pinned HTTPS inputs, then compiles with networking disabled. `--prepare-only` verifies/copies inputs without starting a container. Review and promote the three generated files and their build manifest together; normal application builds do not download or compile native code. Upstream package files remain unchanged.

The manually dispatched [Native reproducibility workflow](../../.github/workflows/native-build.yml)
uses an isolated Ubuntu runner, pulls that same digest, runs the existing build
script and compares all three output hashes and sizes with the promoted manifest.
It uses `--parallel=2` to limit compile jobs and container CPUs on a small runner;
the local script accepts 1-8 jobs and defaults to 8. This changes scheduling,
not the pinned compiler inputs or native policy.
It retains build logs, dependency records and comparison results as a 30-day
artifact. It does not update vendor files or publish a release.

The complete scripted rebuild on 2026-09-14 produced byte-identical JS, WASM and symbol JSON: `.artifacts/local-native/build-Hc060B/result`, compared in `.artifacts/local-native/reproducible-comparison.json`. The fixed container source path `/source` matters because native assertion strings embed `__FILE__`.

Licenses: [wllama](WLLAMA-LICENSE.txt) and [llama.cpp](LLAMA-LICENSE.txt).

The WebGPU build also uses the pinned emdawnwebgpu archive. Its webgpu_cpp/LICENSE
and webgpu/src/LICENSE texts are reproduced in
[runtime notices](../../public/THIRD_PARTY_NOTICES.txt), with the archive hash and
original paths. That notice also reproduces the license texts for native source
components confirmed by the recorded build dependency paths, including the exact
Emscripten 4.0.20 upstream LICENSE, with source and license hashes.

The pinned Emscripten image was inspected directly, with its manifest and SDK
layer verified by SHA-256. Its 790 recorded object-dependency paths and the
historical native debug map resolve to 1,138 distinct SDK paths. The runtime
notice retains the applicable LLVM, musl, dlmalloc, WASI and SIMD source notices,
including source-specific attributions. Builder-only programs are not shipped
in the extension. The mapped evidence describes the existing promoted bundle;
a fresh native compilation remains a separate release check.

Unicode data attribution and the full Unicode License V3 are also included.
The upstream generator did not record its resolved UnicodeData.txt version/hash
or Python Unicode database version. Those historical generation inputs remain
unknown. This rebuild compiles the already-generated table in the hash-pinned
llama.cpp archive; it does not run the generator or fetch current Unicode data.
