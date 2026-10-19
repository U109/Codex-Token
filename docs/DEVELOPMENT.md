# 开发、构建与验证

## 环境

- Node.js 22 或更新版本。
- Python 3.11 或更新版本，使用系统命令 `python`。
- Windows 安装器构建需要 Windows x64、Windows PowerShell 5.1，以及系统的 .NET Framework C# 编译器。
- 非 Windows 可运行源码检查和统计核心测试；Windows 专属安装测试会跳过。

正常构建与测试没有 npm 或 Python 第三方依赖。格式化使用单独安装的开发工具，见下文。PowerShell 源码使用带 BOM 的 UTF-8，以兼容 Windows PowerShell 5.1 的中文解析；其余源码使用 UTF-8。

## 常用命令

```powershell
npm run check
npm test
npm run build
npm run test:release
```

| 命令                    | 检查范围                                                             |
| ----------------------- | -------------------------------------------------------------------- |
| `npm run check`         | JS 语法及本地模块引用、Python 语法、Windows PowerShell 脚本解析      |
| `npm test`              | 合成通知、记录恢复、型号、价格、速度、挂载生命周期与安装事务回归     |
| `npm run build`         | 生成本项目运行脚本、辅助程序、安装器及摘要；不启动官方客户端         |
| `npm run build:release` | `build` 的兼容别名                                                   |
| `npm run test:release`  | 构建来源与载荷摘要、许可文件、两份 EXE 的十档图标和完整 Windows 回归 |
| `npm run test:install`  | 可选的本机最终载荷安装、覆盖升级及卸载烟测，需要已安装官方 Codex     |

`test:release` 已包含单元测试。完整发布检查可依次运行 `format:check`、`check`、`build`、`test:release`。

安装烟测只使用工作区内临时目录，通过 `-NoIntegration` 避免改变真实快捷方式和卸载注册项。它检查官方文件未变及升级后载荷一致性，不启动新官方实例，不替换用户当前安装的助手，不发送模型请求。需在 Windows 本机单独运行，CI 不运行该烟测。

## 统一代码格式

JavaScript、测试、JSON、YAML 和 Markdown 使用 Prettier；Python 使用 Black；C# 使用 CSharpier；PowerShell 使用 PSScriptAnalyzer。工具版本分别固定在 `package-lock.json`、`requirements-dev.txt`、`.config/dotnet-tools.json` 和 `scripts/format.ps1`，项目配置统一缩进与 LF 换行。

首次准备格式化工具需要 .NET 8 SDK（只用于 CSharpier，不用于产品编译）：

```powershell
npm ci
python -m venv .venv
.venv/Scripts/python.exe -m pip install -r requirements-dev.txt
dotnet tool restore
New-Item -ItemType Directory -Path .artifacts/tools -Force | Out-Null
Save-Module -Name PSScriptAnalyzer -RequiredVersion 1.25.0 -Path .artifacts/tools -Repository PSGallery -Force
```

Linux/macOS 使用 `.venv/bin/python` 安装 Python 工具，并跳过 `Save-Module`；PowerShell 格式由 Windows CI 检查。仓库内的开发依赖和虚拟环境均被 Git 忽略；CSharpier 按仓库清单还原，无需全局注册工具。

```powershell
npm run format
npm run format:check
```

`format` 展开并整理受维护的源码、测试与脚本，`format:check` 只检查。格式化不会遍历 `validation` 等历史目录。测试中用于模拟宿主压缩代码的字符串保留原样；独立 C#、PowerShell 测试辅助代码放在 `test/fixtures/`，同样参与格式检查。PowerShell 的哈希表与分号按解析器定位展开，字符串内容和 `for` 循环头保持原样。

## 生成文件

- `dist/CodexToken-Setup-win-x64.exe`：可分发安装器。
- `dist/CodexToken-Setup-win-x64.exe.sha256`：仅供本地验证的安装器摘要，不上传发布页。
- `dist/build-report.json`：含本机构建路径和来源摘要的本地报告。
- `.artifacts/`：本次构建的载荷、测试输出、图标检查及可选烟测报告。

这些目录均被 Git 忽略。GitHub Releases 和 CI 下载产物仅提供安装器 EXE，不上传本机校验文件、报告或官方客户端副本。

## 图标维护

正常构建使用已提交的 ICO，不需要图片库。修改 SVG 母版后，才需要可选的 Sharp：

```powershell
npm install --no-save --package-lock=false sharp
npm run build:icon
```

也可设置 `SHARP_MODULE` 指向已有 Sharp 模块。生成结果写入 `assets/`，预览写入 `.artifacts/app-icon-preview.png`。检查十档图标的清晰度和透明背景后再提交资源。

## 发布前人工核对

在自己可控的宿主环境中检查运行中与完成后的用量、浅深色主题、提示及详情、模型切换、历史刷新恢复和卸载行为。缺失统计应明确显示未知或部分观测，不能补造历史或把价格参考当作扣款。

当前 GitHub Actions 会在 Linux 检查通用源码与测试，在 Windows 构建并验证最终载荷；不会向 GitHub Releases 自动发布。
