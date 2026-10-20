"""将项目 ESM 按依赖顺序合并为单个注入脚本；不包含宿主代码或第三方库。"""

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
# 被依赖模块必须排在使用方之前；遇到不支持的语法立即失败，避免生成半成品。
MODULES = [
    "src/core/request-usage.mjs",
    "src/core/model-timing.mjs",
    "src/core/message-usage.mjs",
    "src/core/pricing.mjs",
    "src/core/conversation-usage.mjs",
    "src/host/app-server-usage.mjs",
    "src/storage/usage-store.mjs",
    "src/host/desktop-bridge.mjs",
    "src/core/usage-metrics.mjs",
    "src/core/model-label.mjs",
    "src/host/model-metadata.mjs",
    "src/host/api-fast-mode.mjs",
    "src/ui/token-badge.mjs",
    "src/ui/conversation-bar.mjs",
    "src/ui/fast-mode-toggle.mjs",
    "src/host/cdp-discovery.mjs",
    "src/host/cdp-runtime.mjs",
]


def bundle(config):
    """支持具名 import 和导出的函数/常量，保留每个模块独立的词法作用域。"""
    parts = ["(async () => {", "'use strict';", "const __ctModules = Object.create(null);"]
    built = set()
    for name in MODULES:
        text = (ROOT / name).read_text("utf-8")
        exports = re.findall(r"^export (?:async )?(?:function|const) (\w+)", text, re.M)

        def dependency(match):
            dep = (Path(name).parent / match[3]).as_posix()
            # resolve 只用于确认模块身份，不执行文件写入。
            dep = (ROOT / dep).resolve().relative_to(ROOT).as_posix()
            if dep not in built:
                raise ValueError("Dependency is missing or out of order: " + dep)
            return "const {" + match[1] + "} = __ctModules[" + json.dumps(dep) + "];"

        # 具名导入允许换行、尾逗号和两种引号，避免格式化后漏掉依赖。
        text = re.sub(
            r"""^import\s*\{([^}]+)\}\s*from\s*(['"])([^'"\r\n]+)\2\s*;""",
            dependency,
            text,
            flags=re.M,
        )
        text = re.sub(r"^export (?=(?:async )?function |const )", "", text, flags=re.M)
        if re.search(r"^\s*(?:import|export)\s", text, re.M):
            raise ValueError("Unsupported ESM syntax in " + name)
        parts += [
            "__ctModules[" + json.dumps(name) + "] = (() => {",
            text,
            "return {" + ",".join(exports) + "};",
            "})();",
        ]
        built.add(name)
    parts += [
        'return await __ctModules["src/host/cdp-runtime.mjs"].installCdpRuntime('
        + json.dumps(config, ensure_ascii=True, separators=(",", ":"))
        + ");",
        "})()",
    ]
    return "\n".join(parts)
