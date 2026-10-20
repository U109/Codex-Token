# 协议与计价参考

以下链接用于解释项目采用的协议与统计口径，不代表官方授权或所有版本的运行兼容性。

| 资料                                                               | 用途                                         |
| ------------------------------------------------------------------ | -------------------------------------------- |
| [Codex App Server](https://developers.openai.com/codex/app-server) | 用量通知、回合身份及型号改路由通知的协议参考 |
| [OpenAI 价格](https://developers.openai.com/api/docs/pricing)      | OpenAI 文本 Token 标准价参考及上下文档位     |
| [DeepSeek 价格](https://api-docs.deepseek.com/quick_start/pricing) | 离线请求计价模块的 DeepSeek 价格参考         |
| [Gemini 价格](https://ai.google.dev/gemini-api/docs/pricing)       | 离线请求计价模块的 Gemini 价格参考           |

价格模块使用 **2026-10-15 的离线快照**，不是实时查询。原始表格摘录和日期保存在 `test/fixtures/pricing-sources.json`，测试逐项核对实现与该快照一致。上游价格变化后，需要重新查阅资料、更新快照和对应测试，不能只修改版本日期。

当前桌面展示中的“标准价参考”与严格的供应商请求估价是独立口径。会话配置、Fast 图标或型号别名不足以证明实际计费档位、地区条件或最终扣费。

原生操作栏挂载使用对当前宿主结构的运行时能力识别，不是官方公开的插件插槽。兼容性和数据完整性约束见 [架构说明](ARCHITECTURE.md)。

0.5.1 的速度口径依据 App Server 的 `item/started`、`item/completed` 及 `thread/tokenUsage/updated` 生命周期（2026-10-19 核对）。公开契约没有提供每次模型请求的精确生成耗时；项目从报告间隔扣除工具区间并标为估算，保留请求输入处理和首 Token 响应，不把它称为服务端纯生成吞吐率。

用量上报时机于 2026-10-20 对照 [模型响应与工具收尾](https://github.com/openai/codex/blob/main/codex-rs/core/src/session/turn.rs) 和 [会话用量、额度通知](https://github.com/openai/codex/blob/main/codex-rs/core/src/session/mod.rs) 核对：文字增量先行，用量在模型响应完成后记录，`thread/tokenUsage/updated` 还可能等相关工具收尾后发出；额度更新也可能重发未变化的用量快照。不能把文字增量次数或通知次数当作请求数。

本地增量采集于 2026-10-20 对照当前客户端的 rollout `token_usage_record` 核对：`response_id`、`usage`、`turn_token_usage`、`thread_token_usage` 分别提供请求身份、单次用量和两级累计检查点。该记录格式属于本地实现，官方文档没有承诺稳定；项目严格校验并保留通知兜底。

同日核对 rollout `turn_context` 中的 `turn_id` 和 `model`：读取器将先于请求出现的同回合模型配置作为历史价格参考，不视为实际路由遥测。明确的 `model/rerouted` 通知仍优先；缺少对应配置时不借用当前选择或其他回合的型号。
