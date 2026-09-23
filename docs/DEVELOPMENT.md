# 开发与验证

需要 Node.js 22.14+、pnpm 11.19.0，依赖锁定见 `package.json` 和 `pnpm-lock.yaml`。

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run prepare
pnpm run typecheck
pnpm test
pnpm run build
pnpm run check:source
```

`prepare` 生成 WXT 类型配置。安装禁用依赖生命周期脚本，随后执行项目准备步骤。构建使用 `vendor` 中带校验的运行时，不读取旧 `.artifacts`，不需要真实服务、Key 或模型权重。

| 命令 | 范围 |
| --- | --- |
| `pnpm run typecheck` | TypeScript 静态检查 |
| `pnpm test` | 自动收集 `test`、`scripts` 下离线 `.test.mjs`，排除两个浏览器存储测试 |
| `node scripts/test.mjs --list` | 列出默认测试文件，避免手工列表漏项 |
| `pnpm run test:indexeddb` | 浏览器 IndexedDB 与目录模型回归，独立临时配置 |
| `pnpm run build` | 生成 `.output/chrome-mv3`，包含校验过的运行时 |
| `pnpm run check:source` | 源码候选及敏感特征检查，不扫描历史或证明所有隐私安全 |
| `pnpm run prepare:github` | 生成 `.artifacts/github-prep/source-*/repository` 及哈希清单 |

CI 在 Windows、Linux 执行离线检查和构建；浏览器、真实网站、真实 Provider、GPU 质量和手动安装分别验收。CI 不发布扩展，不持有真实服务凭据。

## 浏览器与真实场景

浏览器检查需已安装的 Playwright 和兼容浏览器，未作为默认开发依赖锁入仓库。工具通过 `scripts/browser-runtime.mjs` 解析运行环境，不自动下载软件：

- `DANLINGO_PLAYWRIGHT_MODULE`：现有 Playwright 模块的绝对文件路径；未设置时使用项目可解析的 `playwright` 包。
- `DANLINGO_TEST_BROWSER`（或 `DANLINGO_E2E_EXECUTABLE`）：现有浏览器可执行文件的绝对路径；脚本的显式路径参数优先。
- 未指定可执行文件时，普通检查使用 Playwright 已安装的 Chromium；指定 Chrome／Edge 品牌的检查使用对应安装渠道。`PLAYWRIGHT_BROWSERS_PATH` 可指定 Playwright 浏览器缓存。

环境缺失会报错并停止。隔离 Chromium 检查不能替代真实 Chrome／Edge 验收。

浏览器检查使用独立配置。真实页面工具可能访问外部网站，真实服务／性能脚本可能计费；执行前确认地址、样本和停止条件。凭据只用脚本支持的非回显输入或本地排除文件提供，禁止写入源码或命令行。

公开的 `test/fixtures` 使用自编合成材料。Niconico 真实服务工具要求 `--recording <json-file>`，Bilibili 页面探针要求 `--source-evidence <json-file>`；输入先校验来源和结构，再读取凭据或访问页面，合成材料不能作为真实验收输入。采集结果写入被排除的 `.artifacts`，不要提交到仓库。

工具分类见 [scripts 索引](../scripts/README.md)。原生重建见 [构建来源](../vendor/wllama-3.6.1-webgpu/README.md)，普通开发不需要 Docker/Emscripten。

离线 fixture、模拟 Provider、真实网页配模拟服务、真实 Provider 和 GPU 分别说明不同能力。记录版本、环境、场景、分母与未完成项，不把一种场景的通过外推为全部平台的验收结果。
