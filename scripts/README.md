# 开发工具索引

| 类别 | 入口或命名 |
| --- | --- |
| 离线回归 | `test.mjs` 自动收集 `test`、`scripts` 下 `.test.mjs` |
| 固定目录更新 | `workspace_update.py`：独占锁、校验快照、原位同步与中断恢复；使用工作区 `tools/*.ps1` 入口 |
| 更新器故障回归 | `test_workspace_update.py`：Python 3.12+，仅在临时工作区模拟故障及验证 Windows 文件占用 |
| 固定目录重载检查 | `verify-workspace-reload.mjs`：复制四个指定历史快照到隔离工作区，验证两次同版本重载及合成存储保留；不操作用户浏览器配置或真实模型授权 |
| 源码候选 | `source-release.mjs`：白名单、敏感检查、快照与哈希清单 |
| 构建运行时 | `local-wllama-assets.mjs`、`local-native-bundle.mjs` |
| 重建运行时 | `build-local-native.mjs`：固定 Docker 镜像与源输入 |
| 本地模拟页 | `*-fixture.mjs`、`settings-checks.mjs` 等辅助模块 |
| 浏览器验收 | `verify-*.mjs`：按参数区分模拟、真实页面、真实服务 |
| 性能实测 | `benchmark-*.mjs`、`measure-translation-protocol.*`、`replay-translation-cost.mjs` |
| 平台研究 | `probes/`：解析、匿名请求与原生观察 |
| 本地验收维护 | `prepare-live-manual.mjs`、`build-native-candidate.mjs` 等 |

只有默认纯 Node 测试进入 CI。使用其他工具前阅读其入口；部分浏览器或诊断脚本需要本机浏览器／Playwright 配置，也可能访问外部网站或真实服务。

## Bilibili 单条派发验收

在固定源码入口 `D:\Tool\DanLingo-Workspace\development\current` 执行：

```text
node scripts/verify-bilibili-dispatch.mjs prepare
node scripts/verify-bilibili-dispatch.mjs prepare
node scripts/verify-bilibili-dispatch.mjs run
node scripts/verify-bilibili-dispatch.mjs resume
node scripts/verify-bilibili-dispatch.mjs cleanup
```

这些命令已在真实 Chrome 执行成功。`prepare` 按需调用固定工作区更新器、通过扩展自身重载、核对各组件编译身份、应用并恢复会话配置、零调用播放检查及加载当前同一已导入模型（禁用本次加载预热）。第二次复用已核验环境。`run` 自动执行 B→A、导出、分析和恢复；中断用 `resume` 保留账本继续，`cleanup` 可重复执行。不要把上述五行当作每次都要整段重跑的脚本。

一次性准备：Chrome 正常加载 `D:\Tool\DanLingo-Workspace\testing\current\extension`，完成扩展控制页连接授权、目标视频登录或播放权限，以及当前选定本地模型的导入、文件权限和本地组件连接。入口绑定该固定安装的扩展 ID；换安装/profile 时需要正常重新授权，不复制个人资料或绕过权限。普通翻译须保持关闭，使用当前已验证原生 25% 条件。控制通道仅在命令运行期间开放在认证的 loopback 地址，命令退出后关闭。

本入口固定本次视频、区间和已授权预算。检查点、账本及不可变原始导出位于 `.artifacts/bilibili-pretranslation-audit/dispatch-runner-20260926/`。已完成的配对不再次启动模型实验；正式启动后源码或构建变更会触发冻结保护，不能把新构建与旧组拼接，也不能删除账本来重新取得预算。分析器修正可离线分析原始文件，无需重跑模型。

唯一结果报告为 `.artifacts/bilibili-pretranslation-audit/early-rules-20260925/README.md`，分别记录采集构建、之后的离线分析修正、实际调用数和显示证据限制。该流程默认不启用生产筛选或单条策略，不发布正式版。

## Bilibili 用户屏蔽规则只读验收

在固定源码入口运行独立命令，不调用上面的单条派发 A/B 账本：

```text
node scripts/verify-bilibili-user-filters.mjs prepare
node scripts/verify-bilibili-user-filters.mjs run
node scripts/verify-bilibili-user-filters.mjs resume
node scripts/verify-bilibili-user-filters.mjs cleanup
```

`prepare` 在需要时使用固定工作区更新器与扩展控制页重载，检查保存的翻译开关为关闭，先启用后台零模型传输 guard，再打开或刷新任务拥有的固定 Bilibili 视频页。它不枚举、加载或预热模型。`run` 可自行准备环境，只触发当前页的规则读取与观察，约 12 秒内采样状态；它不触发真实 provider 请求。中断后用 `resume` 继续读取状态，不再次发送不确定是否已执行的 `run`。`cleanup` 必须先收到页面恢复确认，才解除后台 guard 并关闭本任务拥有的目标页；如恢复失败，guard 保持开启，修复页面连接后重试。

本轮证据和不可覆盖的检查点保存在 `.artifacts/bilibili-user-filters/regexp-coverage-v1/<时间戳>-<标识>/`；checkpoint 与本轮 `active.json` 都标记 `regexp-coverage-v1`。新轮不会改写旧根的 `active.json` 和历史检查点。若旧根仍有未清理会话，`prepare`、`run`、`resume` 会停止并要求先清理；`cleanup` 会定向恢复该旧会话并追加旧会话检查点，完成后四个入口默认使用本轮目录。`resume` 不删除历史。准备前需由 Chrome 正常加载固定测试扩展目录、授权控制页本机连接及目标视频访问；不会代替用户设置屏蔽规则。实际 Chrome/Edge 上的账号规则与自然过滤结果需要单独验收。运行结束在浏览器扩展页重新加载已更新的测试扩展。

## Bilibili 显示计划本地验收

在固定源码入口运行以下四个入口：

```text
node scripts/verify-bilibili-display-plan.mjs prepare
node scripts/verify-bilibili-display-plan.mjs run
node scripts/verify-bilibili-display-plan.mjs resume
node scripts/verify-bilibili-display-plan.mjs cleanup
```

`prepare` 确认保存的翻译开关已关闭、后台空闲并使用同一已构建版本，再为任务拥有的目标页启用零模型 guard。它不加载或预热本地模型。`run` 只发送一次显示计划运行命令，随后每 3 秒读取不含输入正文的状态，最多观察 35 秒；续跑用 `resume`，只读状态，绝不重发运行命令。输入轨迹或选中事件记录达到上限后停止采样，该轮只能清理，不能续跑。

35 秒状态采样结束后，`run` 显式导出本地输入轨迹，验证连续的单一资源/epoch、无中途暂停或 seek、1x 播放及至少 30 秒的媒体时钟前进；导出保留启动时的前导帧，不丢弃采样区间中间帧。确认后最多执行一次固定 `+12s` seek，等待约 2 秒并再次导出、离线分析。导出保存在 `.artifacts/bilibili-display-plan/v1/`，包含本地输入文本；不应对外分享。导出不包含作者身份或规则正文。完成的 `resume` 会核对并复用已有 run、seek、导出和分析记录，不再次 seek。

`cleanup` 按页面恢复、后台 guard 释放、关闭本任务拥有的目标页执行，并核对设置哈希未变；已完成的清理可重复调用。首次使用前需由 Chrome 正常加载固定测试扩展、授权其控制页连接本机回环通道并允许打开目标视频页。脚本不会操作个人浏览器资料、调用实际 provider 或本地模型。运行后在浏览器扩展页重新加载测试扩展；真实 Chrome/Edge 的用户态验收需单独记录。

## Bilibili 渲染预览验收

在固定源码入口运行独立 runner：

```text
node scripts/verify-bilibili-render-preview.mjs prepare
node scripts/verify-bilibili-render-preview.mjs run
node scripts/verify-bilibili-render-preview.mjs resume
node scripts/verify-bilibili-render-preview.mjs cleanup
```

`prepare` 检查保存的翻译开关为关闭、后台空闲及 build identity；需要时先通过扩展控制页重载到同一构建，再启用单独的临时零模型传输 guard。它保存持久 guard 的脱敏摘要、准备时只读缓存条数与元数据摘要、设置哈希和目标视频会话。缓存摘要不可用时报告为未核对，不写作通过。它不读取持久 guard 的底层值、不加载模型或调用 provider。

`run` 只发送一次预览运行命令，保持任务视频页活动 35 秒，每 3 秒只读一次 `report.clock`、引擎渲染样本及当前 DOM 几何位置；验证同一资源和 epoch、无暂停或 seek、媒体时钟约 1x 前进。之后单次暂停并比较两次只读的媒体位置、当前 DOM 节点 key 和几何位置，单次播放及单次固定 seek，最后显式导出 render report 并用独立分析器检查。导出仅保存 B 摘要和不含正文的 render/geometry 数据，fixture 或离线检查不代表 Bilibili 全部过滤规则、真实 Chrome/Edge 用户态或产品性能通过。

`resume` 按检查点只读状态并继续未完成步骤，不重发运行、播放或 seek；遇到不确定的暂停/播放/seek 结果只用状态确认，不重复发送动作。`cleanup` 先要求页面恢复确认，再释放本轮临时 guard；核对原持久 guard 摘要、可用时的缓存条数与元数据摘要、设置哈希未变，然后只关闭 runner 标记为本轮自有的目标页。证据保存在 `.artifacts/bilibili-render-preview/v1/`。运行前由 Chrome 正常加载固定测试扩展、完成控制页 loopback 授权并允许访问目标视频；结束后在扩展页重新加载测试扩展。真实 Chrome/Edge 验收单独记录。

## Bilibili 真实本地翻译预览

这个独立入口会使用当前选定、已导入且可访问的本地模型；普通翻译必须关闭。旧原文和模拟预览入口仍为零调用。

```text
node scripts/verify-bilibili-live-preview.mjs prepare
node scripts/verify-bilibili-live-preview.mjs run
node scripts/verify-bilibili-live-preview.mjs resume
node scripts/verify-bilibili-live-preview.mjs cleanup
```

`prepare` 在必要时执行固定更新器和扩展重载，核对三端构建、当前模型、任务标签与播放 epoch；允许加载同一模型，关闭预热，保持视频暂停在 45 秒。准备不推理，页面“真实本地翻译（实验）”的启动按钮与 `run` 使用同一路径。临时 auto→ja、并发最多 2，不保存到日常设置。

也可在 `prepare` 创建并绑定的页面中点击“启动”，随后用 `resume` 接续采样；`run` 发现同一任务已由页面启动时也只接续观察。后台持久记录明确启动时间，核对模型、配置、会话和预算后才接续，不重发启动或 seek，不重置余额。尚未启动时 `resume` 不会替用户启动；已停止的许可不能由面板再次启动。连接控制页短暂隐藏目标页时，仅仍在运行的同一任务会回到前台，停止的任务不会自动恢复。

正式运行只消费 B 名单中原定时间在 `[45,85)` 秒的事件，自然播放到 85 秒时撤销供给，画面最多排空到 103 秒。主运行限制为 100 请求、100 输入和 10,000 UTF-16 单位，发送前持久预占；重启不归零。`resume` 核对已有账本和检查点，不重新播放或自动恢复推理。只有存在明确修复原因时，才允许一次最多 20 秒、40 请求/40 输入/4,000 UTF-16 的复验。

`cleanup` 先撤销调用许可、取消并核对空闲，再恢复页面和本任务的模型加载状态，释放自己的临时 guard，并关闭自己创建的标签。不会删除预算历史或释放其他任务的保护。证据位于 `.artifacts/bilibili-live-preview/v1/`；状态记录不含正文，明确的本地导出含原文和译文，供身份与显示核对，不应直接公开。测试、真实运行、可见采样与截图证据分别报告。
