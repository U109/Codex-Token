# 协议与计价参考

以下链接用于解释项目采用的协议与统计口径，不代表官方授权或所有版本的运行兼容性。

| 资料                                                                                                       | 用途                                              |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| [Codex App Server](https://developers.openai.com/codex/app-server)                                         | 用量通知、回合身份及型号改路由通知的协议参考      |
| [Codex 速度](https://developers.openai.com/codex/speed/)                                                   | Fast 开关与服务档位配置                           |
| [Codex 定价](https://learn.chatgpt.com/docs/pricing)                                                       | ChatGPT 包含额度倍率与 Codex Credits 费率         |
| [Codex 配置参考](https://developers.openai.com/codex/config-reference/)                                    | `service_tier`、`features.fast_mode` 与管理员限制 |
| [API Fast mode](https://developers.openai.com/api/docs/guides/fast-mode)                                   | OpenAI 公共 API 的请求档位与响应语义              |
| [Codex 官方答复](https://github.com/openai/codex/issues/14204#issuecomment-4033184620)                     | ChatGPT OAuth 下不能用响应档位判断 Fast 是否生效  |
| [CLIProxyAPI 维护者答复](https://github.com/router-for-me/CLIProxyAPI/issues/4355#issuecomment-5002094130) | 转发 Codex 时分别记录请求档位和响应值             |
| [OpenAI 价格](https://developers.openai.com/api/docs/pricing)                                              | OpenAI 文本 Token 标准价参考及上下文档位          |
| [GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol)                                   | Fast 费率、缓存计价与 272K 长上下文门槛           |
| [DeepSeek 价格](https://api-docs.deepseek.com/quick_start/pricing)                                         | 离线请求计价模块的 DeepSeek 价格参考              |
| [Gemini 价格](https://ai.google.dev/gemini-api/docs/pricing)                                               | 离线请求计价模块的 Gemini 价格参考                |

价格模块使用 **2026-10-15 的离线快照**，不是实时查询。原始表格摘录和日期保存在 `test/fixtures/pricing-sources.json`，测试逐项核对实现与该快照一致。上游价格变化后，需要重新查阅资料、更新快照和对应测试，不能只修改版本日期。

当前桌面展示中的“标准价参考”与严格的供应商请求估价是独立口径。会话配置、Fast 图标或型号别名不足以证明实际计费档位、地区条件或最终扣费。

Fast 响应语义于 **2026-10-20** 核对：Codex 官方明确说明，ChatGPT 登录链路中的 Fast 由服务端路由逻辑处理，响应 `service_tier` 不是可靠的端到端验证字段，返回 `default` 不代表 Fast 被忽略。CLIProxyAPI 维护者也明确要求分别看待请求的 Fast 选择与响应中的 `default` / `auto`。客户端使用 API Key 登录不代表转发服务背后也使用 OpenAI 公共 API；不能直接套用公共 API 的响应档位判断规则，也不能仅凭一次短请求的耗时宣称已验证加速。

## Fast 的开启与确认

以下配置和费率于 **2026-10-20** 对照上表官方文档核对，适用模型、账号资格和管理员策略仍以实际服务为准。

Codex CLI 可使用 `/fast` 切换；官方默认配置为：

```toml
service_tier = "fast"

[features]
fast_mode = true
```

本项目的 API 登录开关保存原生偏好，并在请求通道补齐前端过滤掉的档位；具体值采用模型目录公布的 Fast 档位，不把所有端点强制改成 `fast`。公共 OpenAI API 支持 `service_tier: "fast"` 和兼容别名 `"priority"`；已核对的 CLIProxyAPI v8.0.35 会将 `fast` 转成 ChatGPT Codex 上游接受的 `priority`。不能把公共 API 的字段取值直接套到 OAuth 上游。

| 检查对象                                                                | 可以确认什么                                                                         |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 蓝色闪电、已保存的会话设置                                              | 当前选择了 Fast                                                                      |
| 发往正确上游的请求档位及代理转发记录                                    | 请求确实要求使用 Fast                                                                |
| 公共 OpenAI API 最终响应的 `service_tier`，以及用量后台按档位归类的记录 | 实际处理档位；公共 API 可能降级为 `default` 并按标准价计费                           |
| ChatGPT OAuth 的最终响应                                                | `default` / `auto` 不能确认或否定 Fast；需要服务端路由记录或账号用量记录来进一步核验 |

设置成功和请求携带 Fast 不等于拿到了服务端加速回执。目前采集到的本地用量没有可靠的 OAuth 单请求计费档位；不会把蓝色闪电、短请求耗时或估算输出速度当成这项回执。

## Fast 的费用口径

Token 原始计数保持不变，变化的是费率或额度消耗倍率：

| 实际上游计费方式                           | Fast 的计费或额度消耗                                                            |
| ------------------------------------------ | -------------------------------------------------------------------------------- |
| OpenAI 公共 API Key                        | 使用对应模型、上下文档位的 Fast Token 单价，不能套 ChatGPT Credits 倍率          |
| ChatGPT 订阅包含额度                       | 按同模型 Standard 的 2.5 倍消耗；不是美元费率，也不能用 Credits 价格推算包含额度 |
| ChatGPT 购买 Credits / Enterprise 按量付费 | 同模型 Standard Credits 费率的 2 倍                                              |

例如，GPT-6.1 Sol 公共 API 的文本价格如下，单位为美元 / 百万 Token：

| 服务档位 | 单次请求输入长度 | 未缓存输入 | 缓存读取 | 缓存写入 | 输出 |
| -------- | ---------------- | ---------: | -------: | -------: | ---: |
| Standard | 不超过 272,000   |          2 |     0.10 |     2.50 |   10 |
| Fast     | 不超过 272,000   |          4 |     0.20 |        5 |   20 |
| Standard | 超过 272,000     |          4 |     0.20 |        5 |   15 |
| Fast     | 超过 272,000     |          8 |     0.40 |       10 |   30 |

长上下文依据每一次请求的全部输入长度判断，包含缓存输入；超过门槛时整次请求采用相应长上下文价格。不能将整段聊天的累计输入拿来套用这一门槛。

每次请求的金额为 `（未缓存输入 × 输入单价 + 缓存读取 × 缓存读取单价 + 缓存写入 × 缓存写入单价 + 输出 × 输出单价）/ 1,000,000`。这些输入分类不能重叠；推理 Token 已包含在输出中，不再重复加收。例如，短上下文请求总输入 10,000、其中缓存读取 8,000、缓存写入 0、输出 1,000，Standard 为 **$0.0148**，Fast 为 **$0.0296**。这里只含文本 Token，不含额外工具、地区加价或税费。

同一模型的 Codex Standard Credits 费率为输入 **50**、缓存输入 **2.5**、输出 **250** Credits / 百万 Token；购买 Credits 时 Fast 对应 **100 / 5 / 500**。Codex Credits 没有单独的缓存写入费，Credits 到金额的换算取决于购买价格或合同，不能直接当作美元，也不能据此推算订阅包含额度。

当前产品的“标准价参考”仍逐请求使用 Standard 公开价。严格的 API 请求计价模块已支持 `fast` / `priority`，但桌面采集链路缺少实际计费方式和档位的可靠依据，因此不会用当前 Fast 开关把整段聊天金额乘 2 或 2.5，也不会给先前的 Standard 请求追溯加价。若未来展示 Fast 参考费用，需要逐请求保留当时的请求选择，并明确区分请求参考价和实际扣费；第三方服务另设的价格或倍率仍以其账单为准。

## 采集与宿主协议

原生操作栏挂载使用对当前宿主结构的运行时能力识别，不是官方公开的插件插槽。兼容性和数据完整性约束见 [架构说明](ARCHITECTURE.md)。

0.5.1 的速度口径依据 App Server 的 `item/started`、`item/completed` 及 `thread/tokenUsage/updated` 生命周期（2026-10-19 核对）。公开契约没有提供每次模型请求的精确生成耗时；项目从报告间隔扣除工具区间并标为估算，保留请求输入处理和首 Token 响应，不把它称为服务端纯生成吞吐率。

用量上报时机于 2026-10-20 对照 [模型响应与工具收尾](https://github.com/openai/codex/blob/main/codex-rs/core/src/session/turn.rs) 和 [会话用量、额度通知](https://github.com/openai/codex/blob/main/codex-rs/core/src/session/mod.rs) 核对：文字增量先行，用量在模型响应完成后记录，`thread/tokenUsage/updated` 还可能等相关工具收尾后发出；额度更新也可能重发未变化的用量快照。不能把文字增量次数或通知次数当作请求数。

本地增量采集于 2026-10-20 对照当前客户端的 rollout `token_usage_record` 核对：`response_id`、`usage`、`turn_token_usage`、`thread_token_usage` 分别提供请求身份、单次用量和两级累计检查点。该记录格式属于本地实现，官方文档没有承诺稳定；项目严格校验并保留通知兜底。

同日核对 rollout `turn_context` 中的 `turn_id` 和 `model`：读取器将先于请求出现的同回合模型配置作为历史价格参考，不视为实际路由遥测。明确的 `model/rerouted` 通知仍优先；缺少对应配置时不借用当前选择或其他回合的型号。
