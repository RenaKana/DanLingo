# Microsoft Edge Add-ons 提交清单

## 范围与状态

- 2026-09-30 实查 Partner Center：提交版本 `0.5.1` 为 `In review`，公开链接仍提示发布后可用；审核尚未完成。本次 GitHub 0.5.16 更新不取消或替换该提交。以下 0.5.1 材料保留为该商店提交记录。

- 0.4.0 因 `1.3.1 Product is Testable` 未通过，审核要求可用的测试配置。2026-09-29 已核实 0.5.0 为 `In review`；受限测试配置已通过私密审核备注提供。本轮准备 0.5.1 本地化修订，GitHub 发布、提交审核、审核通过和公开上架分别记录，不混用状态。公开材料不含测试凭据。

- 本次只准备 Microsoft Edge Add-ons；Chrome Web Store 延后单独处理。
- 本轮版本为 `0.5.1`。发布前核对 manifest、商店包、列表内容和校验和中的版本一致。
- `docs/edge-listings.json` 提供 20 个界面语言的名称和列表文案。界面语言数量与可选翻译源语言／目标语言无关。
- 修订后的隐私政策位于 [docs/PRIVACY.md](PRIVACY.md)。公开商店政策链接为 `https://github.com/RenaKana/DanLingo/blob/main/docs/PRIVACY.md`；本次修订需先发布到公开仓库，才能提交该链接。
- 本地 0.5.1 验收与提交证据分别保存在 `.artifacts/release-0.5.1/`、`.artifacts/edge-store/0.5.1/` 和 `.artifacts/edge-review-0.5.1/`；这些目录不进入公开源码。候选包不代表审核通过或已上架。

## Partner Center 与列表

- 由维护者本人用其身份和账号所有权注册／管理 Edge Add-ons Partner Center。Edge 扩展发布账号免费注册；核对提交当日 Partner Center 的最新账户要求。
- 本轮按公开发布、免费扩展准备；第三方翻译服务费用另计。支持入口使用 `https://github.com/RenaKana/DanLingo/issues`。联系邮箱、账号身份及经营者声明由维护者填写真实信息，不从 Git 作者邮箱推断。
- 上传最终 MV3 ZIP，并确认 ZIP 根目录包含 `manifest.json`、许可证和第三方声明；不要包含服务凭据、API Key、模型权重或原始平台录制。
- 每个提交语言提供列表名称、短描述和完整描述；以 `docs/edge-listings.json` 为草稿源，并在 Partner Center 的语言字段中复核格式和截断。
- Edge 列表 Logo 必需：正方形，至少 128×128，推荐 300×300。已生成 `docs/store-assets/icon-300.png`，20 个语言可共用。
- 小型推广图可选：已生成 440×280 的 `docs/store-assets/tile-440x280.png`。
- 截图可选，最多 6 张。已准备 `docs/store-assets/screenshots/` 中 4 张 1280×800 截图，来自 Edge 中真实扩展的英文本地／在线设置、中文和阿拉伯语设置页；不展示虚构翻译结果，也不作为真实网站翻译验收证据。
- 扩展安装图标已放在 `public/icon/{16,32,48,128}.png` 并由 manifest 和工具栏引用；它与 Partner Center 的列表 Logo 是不同用途的资产。
- 发布前核对名称、版本、描述、Logo、隐私政策链接、ZIP 内容与最终校验和，并在 Partner Center 完成隐私与权限问卷。

## 可粘贴的英文审核信息

### Extension purpose

> DanLingo translates supported danmaku in Niconico and Bilibili videos and supported live chat on Niconico, YouTube, and Bilibili. It works on these specific surfaces; it does not translate entire webpages. Users may configure an online Chat Completions-compatible service or select a compatible local GGUF model. Online service use requires the user's own API key and may incur provider charges. Local inference requires a model supplied and authorized by the user. The extension includes 20 interface locales; these are independent of translation source and target languages.

### Permission justifications

> **`storage`:** Stores extension settings, the user's selected credential preference, service configuration, local model references and metadata, and request-limit state. A remembered API key is kept in browser extension storage and is not an operating-system vault or encrypted safe.

> **`offscreen`:** Provides an offscreen extension document for the packaged local inference worker when the user selects local translation.

> **Required site host permissions:** `https://www.nicovideo.jp/*`, `https://live.nicovideo.jp/watch/*`, `https://www.youtube.com/*`, `https://www.bilibili.com/*`, and `https://live.bilibili.com/*` are used by content scripts and native page adapters on the supported Niconico, YouTube, and Bilibili surfaces.

> **Optional `https://*/*` and `http://*/*` host permissions:** Online translation can use a service origin chosen by the user, including a compatible self-hosted endpoint. The extension requests access for the configured host following a user action; the wildcard patterns do not mean all hosts are granted by default. Public endpoints require HTTPS. HTTP is an explicit opt-in limited to loopback or private IPv4 addresses.

### Data use and privacy

> When a user enables online translation, DanLingo sends selected text or protected placeholders, source and target languages, model information, and translation IDs to the user's configured service. The API key is sent in the `Authorization` header to that configured origin. DanLingo does not intentionally send site cookies, account information, authors, video frames, or full-page contents. Text can contain personal information, and provider use can incur fees. Local inference runs with a compatible GGUF model selected by the user. See the privacy policy for storage, request limits, and other details: `https://github.com/RenaKana/DanLingo/blob/main/docs/PRIVACY.md`.

### Remote code declaration

> DanLingo does not load or execute remotely hosted extension code. Its inference worker and WebAssembly runtime are packaged with the extension. A GGUF model is user-selected model data for local inference, not executable extension code; model weights are not included in the package.

### Reviewer test instructions

> Install the submitted extension in Microsoft Edge. Open one of the supported Niconico video/live, YouTube live-chat, or Bilibili video/live surfaces and verify that DanLingo only processes supported danmaku or chat. Test online mode only with a reviewer-controlled compatible endpoint and API key; requests may incur provider charges. To test local mode, select and authorize a compatible GGUF model on the test device; no model weights are included. Credentials or test account details required for review must be supplied only through Partner Center's private review notes, never in the source tree, public listing text, ZIP, or public issue. Report problems through the project issue tracker without posting secrets.

审核操作顺序（英文，可粘贴）：

1. Open the extension popup, then Service and settings. Choose the interface language independently of the translation target language.
2. For online translation, enter the endpoint, model, and limited test credential supplied privately by the publisher. Save and authorize that service, then run the model test. Do not use production credentials.
3. Open a supported video or live-chat page. Enable translation from the popup. Verify translation, stop/restart, navigation to a different resource, and preservation of original text on failure or timeout.
4. For local translation, select the local backend, add a compatible GGUF file or folder, authorize read access, select and load the model, and save. The browser must support WebGPU and JSPI; a minimum browser version alone does not guarantee local inference compatibility.
5. Switch interface languages while editing unsaved settings. Confirm the input remains intact. Clear translation cache and remove any test credential when finished.

提交前须补齐私密测试地址、模型标识和受限凭据（或审核方认可的可测试方案）；当前文档不包含这些值。隐私问卷应披露向用户选择的第三方服务传输网页文字和认证信息，不能因开发者没有自建服务器就选择“不处理任何数据”。按实际问卷字段填写用途和数据类型，并核对与政策一致。

## Edge 实际验收矩阵

以下 10 格均为**待完成**。提审前使用 Edge 加载最终候选包，每格观察至少 20 分钟和 100 条自然产生、需要翻译的消息；自然流量不足时延长观察，注入的合成消息不计数。在线测试必须记录服务商／模型配置和预算；本地测试记录 GGUF 内容指纹、显卡和驱动。记录计数、日期、版本、配置、延迟／及时率、错误率、人工语义评估及证据位置。上架后的正式商店安装验证另列，避免把它变成首次提审的前置条件。

| 平台场景 | 后端 | 状态 | Edge／扩展版本 | 配置与证据 |
| --- | --- | --- | --- | --- |
| Niconico 普通视频 | 在线 | 待完成 | — | — |
| Niconico 普通视频 | 本地 | 待完成 | — | — |
| Niconico 直播 | 在线 | 待完成 | — | — |
| Niconico 直播 | 本地 | 待完成 | — | — |
| YouTube 直播聊天 | 在线 | 待完成 | — | — |
| YouTube 直播聊天 | 本地 | 待完成 | — | — |
| Bilibili 普通视频 | 在线 | 待完成 | — | — |
| Bilibili 普通视频 | 本地 | 待完成 | — | — |
| Bilibili 直播 | 在线 | 待完成 | — | — |
| Bilibili 直播 | 本地 | 待完成 | — | — |

## 独立发布门槛

- [ ] Windows 与 Linux 的真实 GitHub CI 在冻结锁文件下安装并构建通过。
- [x] 复用[已通过的固定输入原生重建与哈希比对](https://github.com/RenaKana/DanLingo/actions/runs/35871624073)：其输入、依赖锁、原生文件、构建脚本和工作流与本地候选一致；本地构建也验证了产物哈希。不是本次候选源码的新 CI 运行。
- [ ] Edge 商店安装版 smoke 检查通过，覆盖初次安装、权限提示、站内设置入口、升级后的设置／缓存／模型引用保留，以及卸载后重装行为。商店 ID 与手动加载／unpacked ID 之间是否迁移状态尚无文档化保证，需在真实商店安装版本上核实，不能假定自动迁移。
- [ ] 最终包仅来自冻结的 `0.4.0` 候选；清点 ZIP 根目录、许可证、第三方声明、图片和隐私链接；排除密钥、模型权重和原始录制。
- [ ] 维护者审阅十格 Edge 验收记录、CI／原生重建证据、限制说明和最终资产，并在 Partner Center 提交前确认。

真实服务、账户登录、自然特殊消息、真实 GPU 和商店安装测试不得用模拟结果代替。Store 页面、检查表或本地构建本身不代表审核通过或已发布。

2026-09-24 本地检查已完成：Windows 离线回归 911/911、类型检查和构建、Edge 隔离存储测试 43 项、多语言模拟交互 106 项；8 个关键标签校正后另通过词典 10 项及文字／布局 43 项。未改写清单的 Edge 候选安装检查 23 项通过，覆盖三类页面的 20 语言和同路径 0.3.0→0.4.0 升级设置保留。以上均不代表前述十格真实平台验收。候选 ZIP 的最终数字与哈希见本地 `package-report.json` 和 `SHA256SUMS`。

## 本地材料生成与验证

Node.js 22.14+、Python 3 和可用的 Playwright／Edge 用于准备。若 Playwright 不在项目依赖中，通过 `DANLINGO_PLAYWRIGHT_MODULE` 指向已安装的模块，不修改生产依赖。

```sh
pnpm run assets:edge
pnpm run build
pnpm run verify:edge
pnpm run typecheck
pnpm test
pnpm run check:source
pnpm run package:edge
```

`verify:edge` 使用隔离配置且阻止网络请求，检查 20 语言、设置／偏好持久化并生成截图。可将 `DANLINGO_UPGRADE_BASELINE` 指向可信的旧版解压目录，验证同一路径／同一 ID 的旧版升级；默认仅检查当前版本重启。它不覆盖真实服务授权、GPU 推理或商店签名升级。

`package:edge` 核对版本、权限、20 语介绍、图标尺寸、包内许可证及 ZIP 内容一致性，扫描工作区源码和安装包的常见敏感模式，生成 SHA256SUMS、逐语言文案和本地报告。精确排除已知本地凭据时，可在本机调用 `python scripts/package-edge.py --compare-credentials <本地文件>`；该文件内容只在内存中比较，不输出凭据。上传文件仅为 `DanLingo-0.4.0-edge-candidate.zip`；不要上传测试配置目录或整个 `.artifacts`。
