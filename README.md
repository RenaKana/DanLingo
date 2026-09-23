# DanLingo

[English](README.en.md)

在 Niconico、YouTube、Bilibili 的原生页面翻译弹幕与直播聊天。支持自行配置兼容 Chat Completions 的服务，或在扩展内加载本地 GGUF 模型。

**版本：0.3.0。** 提供源码和 Chrome／Edge 手动加载 ZIP，安装包见 [GitHub Releases](https://github.com/dabao12123/DanLingo/releases)。

获取 ZIP 后按[安装说明](docs/USAGE.md#安装-zip)解压并加载扩展；也可按下文从源码构建。

## 功能与范围

| 场景 | 当前范围 |
| --- | --- |
| Niconico 普通视频 | 原生文字弹幕、全池／提前 N 秒预译、缓冲区优先、缓存 |
| Niconico 直播 | 屏幕弹幕和评论栏接入 |
| YouTube 直播 | 原站聊天、漏译补翻与置顶消息处理；兼容性取决于原生消息类型 |
| Bilibili 普通视频 | 已审核播放器构建和当前已解码分段；未知版本保留原文 |
| Bilibili 直播 | 弹幕与聊天共享翻译，保留内联表情；补翻和醒目留言存在原生身份识别边界 |
| 本地翻译 | GGUF 文件／目录、WebGPU、单模型多序列；兼容性取决于浏览器、显卡和模型 |

失败、普通超时和不支持的内容按策略保留原文。已显示的直播弹幕不会因普通迟到结果重新发射。Firefox、语音识别、视频字幕、OCR、YouTube 普通视频、Twitch/Kick 尚不支持。

## 从源码运行

需要 Node.js 22.14+ 和 pnpm 11.19.0。Chrome／Edge 使用 Manifest V3；本地 GPU 推理还需要浏览器支持 WebGPU 与 JSPI，清单最低浏览器版本不代表本地模型兼容保证。

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run prepare
pnpm run typecheck
pnpm test
pnpm run build
```

在 `chrome://extensions` 或 `edge://extensions` 打开开发者模式，选择“加载已解压的扩展”，加载 `.output/chrome-mv3`。更新后重新加载扩展并刷新视频页面。

在设置中填写翻译服务地址、模型和自己的 API Key，测试后保存并授权服务；或切换本地后端并选择模型。通过扩展弹窗启停翻译。不需要 DanLingo 账号或另行部署后端。

在线服务可能计费。每日请求上限默认 **3,000 次**，跨标签页和在线服务共享，按本机自然日累计并在重启后保留；重试、补翻、模型测试和性能测试计入，缓存命中、本地推理和模型列表查询不计入。可在设置中修改上限，弹窗显示当天用量。这是请求次数限制，费用上限请在服务方另行设置。

## 文档

- [使用说明](docs/USAGE.md)：服务设置、观看、补翻、本地模型和故障处理。
- [隐私与权限](docs/PRIVACY.md)：发送哪些数据、Key 与缓存存在哪里。
- [项目结构](docs/ARCHITECTURE.md)：入口、调度、平台适配和本地推理边界。
- [开发与验证](docs/DEVELOPMENT.md)：离线测试、浏览器检查和构建步骤。
- [贡献说明](CONTRIBUTING.md) · [安全报告](SECURITY.md) · [文档索引](docs/README.md)

## 许可与依赖

项目原创代码按 [MIT License](LICENSE) 授权，版权署名为 Copyright (c) 2026 Rena。第三方依赖保留各自许可证，见 [运行时声明](public/THIRD_PARTY_NOTICES.txt) 和 [本地原生构建来源](vendor/wllama-3.6.1-webgpu/README.md)。模型权重不随项目提供，使用与分发条件由所选模型另行规定。
