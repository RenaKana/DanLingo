# DanLingo Privacy Policy / DanLingo 隐私政策

**Last revised:** 2026-09-24

**Public policy URL:** https://github.com/RenaKana/DanLingo/blob/main/docs/PRIVACY.md

**Contact:** [DanLingo project issue tracker](https://github.com/RenaKana/DanLingo/issues)

This policy describes DanLingo's browser-extension data flows. The English and Simplified Chinese sections have the same scope.

本政策说明 DanLingo 浏览器扩展的数据处理方式。英文与简体中文部分范围一致。

## English

### Translation data

When online translation is enabled, DanLingo sends the text selected for translation (or protected placeholders), source and target languages, model information, and translation IDs to the service that the user configures. DanLingo does not intentionally attach the website's cookies, account information, author, video frames, or entire page contents. Text itself may contain personal information. Users should review the configured service provider's privacy and data-retention practices.

The API key for the configured service is sent in the `Authorization` header to the exact service origin the user authorizes and configures. A website cannot read that key or choose the destination. However, scripts running on the same page can provide or forge text on the page-to-extension message bridge. If translation is enabled, that text may result in provider requests and usage.

Online requests are subject to per-tab rolling limits of 1,200 unique items or 60,000 source characters per 60 seconds, as well as concurrency limits. A shared daily request cap applies across tabs and online services. It defaults to 3,000 requests, is stored by the device's local calendar day, and survives background restarts. DanLingo stops sending online requests if the counter cannot be reliably stored or the cap has been reached. A request-count limit is not a monetary spending limit; users should set a separate spending limit with their service provider.

### Local models

For local inference, DanLingo reads and runs a model selected by the user inside the extension. Model weights are not included. Directory scanning is limited to a directory the user has authorized. Development diagnostics, real-platform probes, and performance tests are separate tools and are not part of the default offline CI run.

### Credentials and storage

The extension background manages API keys. Keys are not placed in the webpage's main world or in translation messages. The extension settings page is used to enter and manage credentials. If the user chooses “Remember key,” the key is stored in the browser's local extension storage; this is not an operating-system vault or an encrypted safe. Session keys are managed for the browser session.

Each key is bound to an exact origin (scheme, hostname, and port). Browser host permissions cannot isolate ports, so the background also validates the configured origin. Changing the service origin does not automatically reuse the previous key.

Translations are stored in extension IndexedDB. Cache identity includes the source text, resource, languages, backend or model, and translation strategy; the cache has time, item-count, and size limits. Model files, directory authorizations, and metadata are also stored in the extension's browser storage. Daily request counts are stored separately in IndexedDB, retaining per-day usage to prevent resetting the counter by changing the system date. These counts do not contain source text, translated text, or API keys. Removing a key, clearing the cache, and removing a model are separate actions; none resets the online request counter.

### Permissions

| Permission or access | Purpose |
| --- | --- |
| `storage` | Extension settings and credentials the user chooses to remember |
| `offscreen` | An offscreen extension document for local inference |
| Specified Niconico, YouTube, and Bilibili hosts | Content scripts and native page adapters on supported pages |
| Optional HTTP/HTTPS hosts | A translation service origin the user configures and authorizes through an action in the extension |
| Packaged WebAssembly | The bundled local inference runtime |

Optional wildcard host patterns do not grant access to every site by default. Public internet endpoints require HTTPS. HTTP must be explicitly enabled and is restricted to loopback or private IPv4 addresses. The settings page can be opened from supported sites for in-site settings; this does not let a site perform arbitrary background actions.

### Source publication

The `pnpm run prepare:github` process creates an allowlisted source candidate, scans for common token patterns and known local test credentials, and excludes local build output, real service configuration, and browser profiles. Scanning cannot prove that every obfuscated or unknown secret, or information embedded in an image, has been removed. The file list must still be reviewed before sharing.

### Contact

For privacy questions, use the [DanLingo project issue tracker](https://github.com/RenaKana/DanLingo/issues). Do not post API keys, passwords, or other secrets in a public issue.

## 简体中文

### 翻译数据

启用在线翻译后，DanLingo 会将待译文字（或受保护的占位符）、源语言和目标语言、模型信息及翻译 ID 发送到用户配置的服务。DanLingo 不会主动附带网站 Cookie、账号信息、作者信息、视频画面或整页内容。文字本身可能含有个人信息，用户应了解所配置服务商的隐私和数据保留规则。

配置服务的 API Key 会通过 `Authorization` 请求头发送到用户授权并配置的精确服务 origin。网页不能读取该 Key，也不能选择请求目标。但是，同一网页中运行的脚本可以通过网页与扩展之间的消息桥提供或伪造文字。若已启用翻译，这些文字可能触发服务请求并产生用量。

在线请求受每标签页滚动限额约束：每 60 秒最多 1,200 个唯一条目或 60,000 个原文字，并受并发限制。所有标签页和在线服务共用每日请求上限，默认 3,000 次；按设备本地自然日保存，后台重启后仍有效。若计数无法可靠保存或已达上限，DanLingo 会停止发送在线请求。请求次数上限不是金额上限；用户应另外在服务商处设置费用额度。

### 本地模型

本地推理时，DanLingo 会在扩展内读取并运行用户选择的模型。扩展不包含模型权重。目录扫描仅限于用户授权的目录。开发诊断、真实平台探针和性能测试是独立工具，不属于默认离线 CI。

### 凭据与存储

API Key 由扩展后台管理，不会放入网页主世界或翻译消息。用户通过扩展设置页输入和管理凭据。若选择“记住 Key”，Key 会存入浏览器本机扩展存储；这不是操作系统保险库或加密保险箱。会话 Key 按浏览器会话管理。

每个 Key 都绑定到精确 origin（协议、主机名和端口）。浏览器主机权限无法按端口隔离，因此后台还会验证实际配置的 origin。修改服务 origin 后不会自动沿用原 Key。

译文保存在扩展 IndexedDB 中。缓存身份包含原文、资源、语言、后端或模型及翻译策略，并设有时间、条数和大小上限。模型文件、目录授权和元数据也保存在扩展的浏览器存储中。每日请求计数单独保存于 IndexedDB，按日保留用量以防通过修改系统日期重置计数；计数不含原文、译文或 API Key。删除 Key、清除缓存和移除模型分别执行，均不会重置在线请求计数。

### 权限

| 权限或访问范围 | 用途 |
| --- | --- |
| `storage` | 扩展设置，以及用户选择记住的凭据 |
| `offscreen` | 用于本地推理的离屏扩展文档 |
| 指定的 Niconico、YouTube 和 Bilibili 主机 | 在支持页面运行内容脚本和原生页面适配器 |
| 可选 HTTP/HTTPS 主机 | 用户通过扩展操作配置并授权的翻译服务 origin |
| 随扩展打包的 WebAssembly | 本地推理运行时 |

可选通配主机模式不会默认授予所有网站访问权。公网服务必须使用 HTTPS。HTTP 必须由用户明确启用，并限制为回环或私有 IPv4 地址。支持的网站可打开设置页进行站内设置，但不能因此执行任意后台操作。

### 源码公开

`pnpm run prepare:github` 会生成白名单源码候选，扫描常见令牌特征和已知本地测试凭据，并排除本地构建产物、真实服务配置和浏览器资料。扫描不能证明所有变形或未知密钥以及图片中的信息都已移除。公开前仍须核对文件清单。

### 联系方式

如有隐私问题，请通过 [DanLingo 项目问题跟踪页](https://github.com/RenaKana/DanLingo/issues)联系。请勿在公开问题中发布 API Key、密码或其他秘密信息。
