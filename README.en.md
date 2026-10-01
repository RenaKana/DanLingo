# DanLingo

[中文](README.md)

Translate danmaku and live chat directly on Niconico, YouTube and Bilibili. Connect your own Chat Completions service or load a local GGUF model in the extension.

**Current version: 0.5.20. Download from [Releases](https://github.com/RenaKana/DanLingo/releases).** This release fixes reasoning capabilities becoming unavailable after 24 hours and Bilibili planned requests being rejected by clock differences. It also explains mismatched hybrid capacity and unsupported reasoning settings, and includes automatic Index-Translate prompts and visible output from failed model tests. Edge Add-ons is not publicly available yet; store review is separate from GitHub publication, and an in-review submission is not an approval. Chrome Web Store submission is postponed.

The interface supports 20 languages, follows the browser by default, and can be set independently of the translation source and target languages. The popup and Settings page share nine target-language presets and both accept a custom target language.

## Build and install

Use Node.js 22.14+ and pnpm 11.19.0:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run prepare
pnpm run typecheck
pnpm test
pnpm run build
```

Open `chrome://extensions` or `edge://extensions`, enable Developer mode, choose **Load unpacked**, and select `.output/chrome-mv3`. Reload the extension and refresh video pages after updating. The future release ZIP must be extracted before loading it. This `.output` workflow is for a standalone repository clone; it does not apply to the local fixed workspace.

Settings open in a standalone extension page. On a new installation, the online endpoint and model are blank and the profile defaults to Automatic. Enter your service address, model and API key, test the model, then save and grant permission for that service. Existing settings are retained when updating the extension. Alternatively, choose the local backend and select your GGUF files or directory. Enable translation from the extension popup. DanLingo does not require an account or a separate application server.

For the local fixed workspace at `D:\Tool\DanLingo-Workspace`, use **Load unpacked** once in Chrome or Edge and choose either the testing path, `D:\Tool\DanLingo-Workspace\testing\current\extension`, or the release path, `D:\Tool\DanLingo-Workspace\releases\current\extension`. Keep the old extension and browser data. A new installation may require re-entering service settings, registering models and granting service or model permissions. After the first import, use **Reload** for later updates; do not import a snapshot again. See the in-repository [development guide](docs/DEVELOPMENT.md) for the workflow.

## Scope and costs

The implementation covers Niconico videos and live streams, YouTube live chat, and Bilibili videos and live streams. Player revisions and special message types have separate compatibility requirements. Unsupported messages, failures and timeouts preserve the original text. Local inference needs compatible WebGPU, JSPI, GPU drivers and model architecture; the manifest's minimum browser version does not guarantee those capabilities. Firefox, speech recognition, OCR and YouTube video subtitles are not supported.

## Local models to try

These are Tencent's official GGUF repositories. Choose according to your device's resources:

- [Hy-MT2-1.8B](https://huggingface.co/tencent/Hy-MT2-1.8B-GGUF): 1.8B parameters; a good starting point.
- [Hy-MT2-7B](https://huggingface.co/tencent/Hy-MT2-7B-GGUF): 7B parameters, for devices with more resources.
- [Hy-MT2-30B-A3B](https://huggingface.co/tencent/Hy-MT2-30B-A3B-GGUF): 30B total parameters, with about 3B activated during inference; do not budget memory as if it were a 3B model.

For danmaku with frequent internet slang, try Index-Translate first. In user-reported hands-on testing, Index-Translate-2B.Q8_0 adapted better to internet slang and nonstandard spellings:

| Model (user-reported test) | Translation of “666这个入是挂” |
| --- | --- |
| Index-Translate-2B.Q8_0 | `666このユーザーはチートです` |
| Hy-MT2-1.8B-Q8_0 | `666という数字は、単に掛けられているだけです。` |

This example is user-reported feedback, not a system benchmark, and does not show that Index-Translate is better for every task.

Actual resource use depends on quantization, context and runtime environment. The project has not validated every file in these repositories. Browser compatibility and translation quality of each GGUF file still need testing on your device and workloads.

Choose the local backend in Settings, use **Add folder** or **Add file** to select a source directly, then click **Load model** on its row in **Manage models**. File selection supports multiple files; include every shard of a split model. Loading saves the model choice and uses the current performance settings for that load only; other settings drafts remain unsaved.

You can also explore the open-source [Index-Translate text model family](https://github.com/bilibili/Index-Translate), which offers [2B](https://huggingface.co/IndexTeam/Index-Translate-2B), [9B](https://huggingface.co/IndexTeam/Index-Translate-9B), and [35B-A3B (preview)](https://huggingface.co/IndexTeam/Index-Translate-35B-A3B-preview) checkpoints. The 35B-A3B checkpoint is still a preview; consider serving resources when choosing a model. Version 0.5.18 detects model names containing `Index-Translate` and automatically applies the official single-user translation prompt, keeping prompts consistent for ordinary videos and live streams. For compatible GGUFs, keep prompt mode set to **Automatic**. Official Hugging Face checkpoints are not GGUF and cannot be loaded by the built-in local model loader; connect them through a compatible Chat Completions service using the online-model settings. The comparison above covers only the user-tested Index-Translate-2B.Q8_0 and Hy-MT2-1.8B-Q8_0; other model sizes, quantizations and hardware combinations still need separate validation.

Online translation sends text to the selected provider and may incur fees. The daily request cap defaults to **0 (unlimited)**. A positive value enables a cap shared across tabs and online services and counted by local calendar day. Retries, repairs, model tests and performance tests count; cache hits, merged work, local inference and model-list queries do not. A previously saved positive cap is preserved when updating. This limits request count, not spending; set a separate spending limit with your provider.

Online and local concurrency are separate settings, each defaulting to **2** for a new installation; existing concurrency settings are preserved on update. Increasing online concurrency usually improves request throughput. Local concurrency depends on device and model inference performance: higher is not always faster, and too much concurrency can increase queueing. Tune it with measurements on your device instead of copying the online value.

Automatic unloading of an idle local model is enabled by default after **5 minutes**; it can be disabled or adjusted in minutes. The first live-translation pass waits up to **3 seconds** by default. Timeout retries have independent, off-by-default switches per platform. When enabled, the second attempt itself waits up to **4 seconds (the 3-second first-pass setting + 1-second extra setting)**. These timings are configurable.

API keys and caches remain in browser storage. Only retain a key when you trust the device. Local model files and weights are not shipped with the project; their own licenses apply.

## Documentation and contribution

- [Usage](docs/USAGE.md) and [privacy/permissions](docs/PRIVACY.md)
- [Architecture](docs/ARCHITECTURE.md) and [development checks](docs/DEVELOPMENT.md)
- [Contributing](CONTRIBUTING.md) and [security reports](SECURITY.md)
- [Native build provenance](vendor/wllama-3.6.1-webgpu/README.md)
- [Edge submission preparation](docs/EDGE_STORE.md)

Most detailed guides are in Chinese; the privacy policy is also available in English. Do not include API keys, personal profiles or private chat recordings in reports.

## License

Original project code is available under the [MIT License](LICENSE), Copyright (c) 2026 Rena. Bundled dependencies retain their [own notices](public/THIRD_PARTY_NOTICES.txt). Repository: `RenaKana/DanLingo`.
