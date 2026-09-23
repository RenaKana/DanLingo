# 项目结构

```text
entrypoints/             WXT 扩展入口、后台、页面和内容脚本
  background.ts          设置、授权、翻译请求、缓存与后台调度
  options/               设置界面
  popup/                 扩展弹窗
  offscreen/             本地模型的扩展离屏页
  model-folders/         模型目录选择与管理
src/
  core/                  设置、消息协议、资源身份与播放/直播调度
  translation/           Provider 协议、批处理、缓存、去重、用量
  local/                 GGUF 导入、目录持久化、Worker 与本地推理
  platforms/             各网站原生播放器、聊天与补翻适配
  ui/                    进度、诊断、主题和共用控件
test/                    core、translation、ui 回归与 fixtures
scripts/                 构建、离线测试、浏览器验证与诊断工具
  probes/                平台研究工具和对应解析测试
public/                  随扩展复制的静态文件与第三方声明
vendor/                  有来源、许可证与校验值的本地推理运行时
docs/                    使用与开发文档
.github/workflows/       离线 CI，不发布扩展、不调用真实服务
```

网站主世界适配器读取原生消息，经受限消息桥交给内容脚本；后台负责服务权限、凭据、翻译引擎和缓存；结果通过适配器回到原生显示。网站页面数据不能被视为可信控制指令。

普通视频按资源、播放位置和缓冲范围安排预译；直播使用有限等待预算，保留消息事件身份与显示顺序。计算去重与事件显示去重不同，同文消息仍可能是不同事件。失败需要保留原文。

远程后端使用用户配置的服务；本地后端经 `offscreen` 页面及 Worker 加载用户选择的 GGUF。目录句柄、模型文件和译文缓存在浏览器自身存储中；源码不包含用户模型。

在线请求在实际生成请求发送前，由 `core/online-budget.ts` 使用持久化事务原子预占当天额度。翻译、重试和测试共用后台入口；本地推理、缓存及模型列表不计数。外部模型在扫描、手动刷新和加载时计算完整分块指纹，Worker 返回进度，存储提交保留取消与并发修订检查；内容或旧身份发生变更时换用新的缓存身份。

## 维护约定

- 共享逻辑放在 `core`、`translation` 或 `local`，站点选择器和原生协议保留在对应平台目录。
- 构建所需的 `scripts/local-wllama-assets.mjs`、`local-native-bundle.mjs` 与 `vendor` 必须一起提供；普通构建不下载模型或重编译原生代码。
- `scripts/test.mjs` 自动收集纯 Node 回归；浏览器存储测试单独运行。新增 `.test.mjs` 应保持离线、无个人配置依赖。
- `.artifacts`、`.output`、`.wxt`、`node_modules`、`.pnpm-store` 属于本地生成物，不加入版本控制。
- `scripts/probes` 和顶层 `probes` 是研究工具，不是扩展运行时入口。后者不进入源码候选。
