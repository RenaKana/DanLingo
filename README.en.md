# DanLingo

[中文](README.md)

Translate danmaku and live chat directly on Niconico, YouTube and Bilibili. Connect your own Chat Completions service or load a local GGUF model in the extension.

**Version: 0.3.0.** Available as source and a ZIP for manual installation in Chrome and Edge. Download the extension from [GitHub Releases](https://github.com/dabao12123/DanLingo/releases).

## Build and install

Use Node.js 22.14+ and pnpm 11.19.0:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run prepare
pnpm run typecheck
pnpm test
pnpm run build
```

Open `chrome://extensions` or `edge://extensions`, enable Developer mode, choose **Load unpacked**, and select `.output/chrome-mv3`. Reload the extension and refresh video pages after updating. The future release ZIP must be extracted before loading it.

Open the extension settings, enter your endpoint, model and API key, test the model, then save and grant permission for that service. Alternatively, choose the local backend and select your GGUF files or directory. Enable translation from the extension popup. DanLingo does not require an account or a separate application server.

## Scope and costs

The implementation covers Niconico videos and live streams, YouTube live chat, and Bilibili videos and live streams. Player revisions and special message types have separate compatibility requirements. Unsupported messages, failures and timeouts preserve the original text. Local inference needs compatible WebGPU, JSPI, GPU drivers and model architecture; the manifest's minimum browser version does not guarantee those capabilities. Firefox, speech recognition, OCR and YouTube video subtitles are not supported.

Online translation sends text to the selected provider and may incur fees. A persistent daily request cap defaults to **3,000**, shared across tabs and online services and counted by local calendar day. Retries, repairs, model tests and performance tests count; cache hits, merged work, local inference and model-list queries do not. Saving a higher limit permits new requests; it does not replay old live messages. This is a request-count cap, not a monetary spending limit. Set a separate spending limit with your provider.

API keys and caches remain in browser storage. Only retain a key when you trust the device. Local model files and weights are not shipped with the project; their own licenses apply.

## Documentation and contribution

- [Usage](docs/USAGE.md) and [privacy/permissions](docs/PRIVACY.md)
- [Architecture](docs/ARCHITECTURE.md) and [development checks](docs/DEVELOPMENT.md)
- [Contributing](CONTRIBUTING.md) and [security reports](SECURITY.md)
- [Native build provenance](vendor/wllama-3.6.1-webgpu/README.md)

These detailed guides are currently in Chinese. Do not include API keys, personal profiles or private chat recordings in reports.

## License

Original project code is available under the [MIT License](LICENSE), Copyright (c) 2026 Rena. Bundled dependencies retain their [own notices](public/THIRD_PARTY_NOTICES.txt). Repository: `dabao12123/DanLingo`.
