# 开发工具索引

| 类别 | 入口或命名 |
| --- | --- |
| 离线回归 | `test.mjs` 自动收集 `test`、`scripts` 下 `.test.mjs` |
| 源码候选 | `source-release.mjs`：白名单、敏感检查、快照与哈希清单 |
| 构建运行时 | `local-wllama-assets.mjs`、`local-native-bundle.mjs` |
| 重建运行时 | `build-local-native.mjs`：固定 Docker 镜像与源输入 |
| 本地模拟页 | `*-fixture.mjs`、`settings-checks.mjs` 等辅助模块 |
| 浏览器验收 | `verify-*.mjs`：按参数区分模拟、真实页面、真实服务 |
| 性能实测 | `benchmark-*.mjs`、`measure-translation-protocol.*`、`replay-translation-cost.mjs` |
| 平台研究 | `probes/`：解析、匿名请求与原生观察 |
| 本地验收维护 | `prepare-live-manual.mjs`、`build-native-candidate.mjs` 等 |

只有默认纯 Node 测试进入 CI。使用其他工具前阅读其入口；部分浏览器或诊断脚本需要本机浏览器／Playwright 配置，也可能访问外部网站或真实服务。
