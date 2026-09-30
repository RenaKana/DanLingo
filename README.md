# DanLingo

[English](README.en.md)

在 Niconico、YouTube、Bilibili 的原生页面翻译弹幕与直播聊天。支持自行配置兼容 Chat Completions 的服务，或在扩展内加载本地 GGUF 模型。

**正式版本：0.5.16，可通过 [GitHub Releases](https://github.com/RenaKana/DanLingo/releases) 下载并手动加载。** 本版更新 Bilibili 播放器兼容、翻译调度、模型能力识别和设置界面。Edge Add-ons 的 0.5.1 仍在审核中，尚未公开上架；商店审核与 GitHub 发布分别进行。Chrome 商店上架暂缓。

获取 ZIP 后按[安装说明](docs/USAGE.md#安装-zip)解压并加载扩展；也可按下文从源码构建。

## 功能与范围

界面支持 20 种语言，默认跟随浏览器，也可单独设置；界面语言不改变翻译的源语言和目标语言。弹窗和设置页共用 9 个目标语言预设，并都支持输入自定义目标语言。

| 场景 | 当前范围 |
| --- | --- |
| Niconico 普通视频 | 原生文字弹幕、全池／提前 N 秒预译、缓冲区优先、缓存 |
| Niconico 直播 | 屏幕弹幕和评论栏接入 |
| YouTube 直播 | 原站聊天、漏译补翻与置顶消息处理；兼容性取决于原生消息类型 |
| Bilibili 普通视频 | 已审核播放器构建和当前已解码分段；未知版本保留原文 |
| Bilibili 直播 | 弹幕与聊天共享翻译，保留内联表情；补翻和醒目留言存在原生身份识别边界 |
| 本地翻译 | GGUF 文件／目录、WebGPU、单模型多序列；兼容性取决于浏览器、显卡和模型 |

失败、普通超时和不支持的内容按策略保留原文。已显示的直播弹幕不会因普通迟到结果重新发射。Firefox、语音识别、视频字幕、OCR、YouTube 普通视频、Twitch/Kick 尚不支持。

## 推荐尝试的本地模型

以下链接均为腾讯官方 GGUF 仓库，可按设备资源选择：

- [Hy-MT2-1.8B](https://huggingface.co/tencent/Hy-MT2-1.8B-GGUF)：1.8B 参数，建议优先尝试。
- [Hy-MT2-7B](https://huggingface.co/tencent/Hy-MT2-7B-GGUF)：7B 参数，适合资源更充足的设备。
- [Hy-MT2-30B-A3B](https://huggingface.co/tencent/Hy-MT2-30B-A3B-GGUF)：30B 总参数、约 3B 激活参数；内存不能仅按 3B 模型估算。

实际占用取决于量化、上下文和运行环境。项目未验证这些仓库中的每个文件；具体 GGUF 文件的浏览器兼容性与翻译效果仍需在你的设备和使用场景中验证。

在设置中切换本地后端，点击“添加文件夹”或“添加文件”直接选择来源，再在“管理模型”对应行点击“加载模型”。文件选择支持多选，分片模型需选齐全部分片。加载会保存模型选择；当前性能参数仅用于本次加载，其他设置草稿不会随之保存。

## 从源码运行

需要 Node.js 22.14+ 和 pnpm 11.19.0。Chrome／Edge 使用 Manifest V3；本地 GPU 推理还需要浏览器支持 WebGPU 与 JSPI，清单最低浏览器版本不代表本地模型兼容保证。

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run prepare
pnpm run typecheck
pnpm test
pnpm run build
```

在 `chrome://extensions` 或 `edge://extensions` 打开开发者模式，选择“加载已解压的扩展”，加载 `.output/chrome-mv3`。更新后重新加载扩展并刷新视频页面。此 `.output` 流程适用于独立克隆的仓库，不适用于本机固定工作区。

所有设置都在独立的扩展页面打开。新安装时在线服务地址和模型为空，配置档位默认为“自动”；填写自己的服务地址、模型和 API Key，测试后保存并授权服务。已有设置会在更新后保留。也可切换本地后端并选择模型。通过扩展弹窗启停翻译。不需要 DanLingo 账号或另行部署后端。

在线服务可能计费。每日请求上限默认 **0（不限）**；设为正整数后，跨标签页和在线服务按本机自然日共享该上限并在重启后保留。重试、补翻、模型测试和性能测试计入，缓存命中、本地推理和模型列表查询不计入。升级时已保存的正值上限会保留；这是请求次数限制，费用上限请在服务方另行设置。

在线与本地并发分别设置，首次使用默认各为 **2**，升级时保留已有并发设置。提高在线并发通常能增加请求吞吐；本地并发受设备和模型推理能力影响，并发更高不一定更快，过高还会增加排队等待。请按本机实测调整本地并发，不要照搬在线设置。

本地模型闲置自动卸载默认开启，等待 **5 分钟**；可关闭或调整等待时间。直播首轮默认最多等待 **3 秒**；各平台的超时自动补翻开关独立且默认关闭。开启后，第二轮自身最多等待 **4 秒（首轮设置 3 秒 + 额外设置 1 秒）**，相关时间均可调整。

使用本机固定工作区 `D:\Tool\DanLingo-Workspace` 时，首次在 Chrome／Edge 选择“加载已解压的扩展”并导入以下固定目录之一：测试版 `D:\Tool\DanLingo-Workspace\testing\current\extension`，正式版 `D:\Tool\DanLingo-Workspace\releases\current\extension`。保留旧扩展和浏览器数据；若作为新安装，可能需要重新填写服务配置、登记模型并授予服务与模型所需授权。首次导入后，后续只在扩展管理页点击“重新加载”，不要重新导入快照。更新步骤见[开发指南](docs/DEVELOPMENT.md)。

## 文档

- [使用说明](docs/USAGE.md)：服务设置、观看、补翻、本地模型和故障处理。
- [隐私与权限](docs/PRIVACY.md)：发送哪些数据、Key 与缓存存在哪里。
- [项目结构](docs/ARCHITECTURE.md)：入口、调度、平台适配和本地推理边界。
- [开发与验证](docs/DEVELOPMENT.md)：离线测试、浏览器检查和构建步骤。
- [Edge 上架准备](docs/EDGE_STORE.md)：商店材料、审核说明与待完成验收。
- [贡献说明](CONTRIBUTING.md) · [安全报告](SECURITY.md) · [文档索引](docs/README.md)

## 许可与依赖

项目原创代码按 [MIT License](LICENSE) 授权，版权署名为 Copyright (c) 2026 Rena。第三方依赖保留各自许可证，见 [运行时声明](public/THIRD_PARTY_NOTICES.txt) 和 [本地原生构建来源](vendor/wllama-3.6.1-webgpu/README.md)。模型权重不随项目提供，使用与分发条件由所选模型另行规定。
