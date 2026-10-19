# Codex Token

为 Windows Codex 桌面客户端增加逐回复用量统计，查看 Token、缓存命中率、价格参考及模型输出速度。当前版本 **0.5.3**。

[下载 Windows 安装器](https://github.com/U109/Codex-Token/releases/latest/download/CodexToken-Setup-win-x64.exe)

**非官方项目，与 OpenAI 无隶属或背书关系。** 通过本机 CDP 接口在运行时加载组件，使用普通用户权限，不复制或修改官方客户端文件。

## 界面预览

在每条回复下方，复制按钮旁的用量图标会显示本轮 Token 总量。达到一百万时使用 M 展示，例如 `4.41M`；点击详情可查看完整数值。

![回复操作栏中的用量图标与 Token 总量](docs/images/usage-toolbar.png)

点击用量图标，展开查看模型、价格参考、输入、输出、缓存读取、缓存命中率和输出速度估算。

![用量明细面板，展示模型、价格参考、Token 分类、缓存命中率和输出速度估算](docs/images/usage-details.png)

## 功能

- 逐回复显示 Token 总量、输入、输出、缓存读取和命中率。
- 运行中实时刷新，完成后保存，刷新页面可恢复。
- 按模型计算价格参考，估算输出速度并扣除工具执行时间。
- 支持直接覆盖升级，无需先卸载。

价格采用 **2026-10-15 公开价快照**，不代表实际账单；速度为估算值。缺少上报时保留未知或“数据不完整”提示。

## 安装与使用

需要 Windows x64 和当前用户已安装的官方 Codex 桌面客户端。

1. [下载 `CodexToken-Setup-win-x64.exe`](https://github.com/U109/Codex-Token/releases/latest/download/CodexToken-Setup-win-x64.exe)，安装只需要这一个文件。
2. 运行安装器，已有安装会自动覆盖升级。
3. 保存工作并完全退出 Codex，再通过桌面或开始菜单中的 **Codex Token** 快捷方式启动。
4. 点击回复旁的用量图标查看详情。直接从官方入口启动时不保证加载增强。

安装器未签名。运行增强时会启用仅限 `127.0.0.1` 的随机调试端口；不要转发该端口或运行不可信调试脚本。卸载可通过 Windows 设置完成，完全退出 Codex 后调试端口才会关闭。更多说明见 [安全说明](SECURITY.md)。

## 从源码构建

需要 Node.js 22+、Python 3.11+；Windows 构建使用系统的 .NET Framework C# 编译器和 Windows PowerShell 5.1。正常构建无需安装第三方依赖。

```powershell
npm run check
npm run build
npm run test:release
```

`test:release` 包含完整 Windows 回归测试、载荷与来源摘要检查、许可文件检查，以及两个可执行文件的十档图标校验。输出安装器位于 `dist/`。日常仅运行回归测试可使用 `npm test`。

开发时使用 `npm run format` 统一代码格式，使用 `npm run format:check` 检查格式。格式化工具的首次安装步骤见 [开发说明](docs/DEVELOPMENT.md#统一代码格式)。

生成目录 `dist/`、`.artifacts/` 和本机历史实验目录均不会进入 Git 提交。安装包通过 GitHub Releases 分发，源码仓库不分发官方客户端文件或本机验证日志。

## 代码导航

| 路径                 | 内容                                       |
| -------------------- | ------------------------------------------ |
| `src/core/`          | 记录校验、消息索引、计价、速度与型号名称   |
| `src/host/`          | 宿主能力发现、通知采集、型号订阅与界面挂载 |
| `src/storage/`       | 历史恢复、持久化与健康状态                 |
| `src/ui/`            | 用量按钮、提示与详情组件                   |
| `packaging/windows/` | Windows 安装器、运行助手与安装事务         |
| `scripts/`           | 构建和验证工具                             |
| `test/`              | 回归测试与离线样本                         |
| `assets/`            | 本项目图标资源                             |

详见 [架构说明](docs/ARCHITECTURE.md)、[开发说明](docs/DEVELOPMENT.md) 和 [协议与计价参考](docs/SOURCES.md)。

## 兼容性与贡献

宿主私有结构可能随更新变化，自动识别不代表保证所有版本兼容。自动化测试使用合成数据；正式客户端中的界面与重启恢复需要单独验收。

欢迎提交问题与 Pull Request，参与方式见 [贡献指南](CONTRIBUTING.md)。分享诊断信息前请移除聊天正文、凭据及调试地址。

本项目采用 [MIT 许可证](LICENSE)。
