// 一次性脚本：在 README 「隐私脱敏」与「工具用法」之间插入「日志与诊断」小节（幂等）。
// 用字节级替换规避 filesystem-replace_edit 的 fuzzy 缩进坑；LF 无 BOM 写回。
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(__dirname, "..", "README.md");

const RAW = readFileSync(file, "utf8");
const text = RAW.replace(/\r\n?/g, "\n"); // 归一化 CRLF/LF

const anchor = "## 工具用法\n";
if (text.includes("## 日志与诊断\n")) {
  console.log("SKIP: 日志与诊断 小节已存在");
  process.exit(0);
}

const section = [
  "## 日志与诊断",
  "",
  "所有日志一律写入 **stderr**（`stdio` 传输下 stdout 是 MCP 协议通道，任何诊断都不得走 stdout），且**不带时间戳前缀**，保证每行都是完整文本、便于解析。",
  "",
  "### 日志级别",
  "",
  "启动时用 `--log-level <level>` 控制输出阈值（默认 `info`）：",
  "",
  "| 级别 | 说明 |",
  "| --- | --- |",
"| `silly` | 全量调试 |",
  "| `debug` | 调试细节 |",
  "| `info`  | 常规信息（默认） |",
  "| `warn`  | 警告 |",
  "| `error` | 仅错误 |",
  "",
  "级别大小写不敏感；无效或缺失的值回落为 `info` 并打一条 `[cli]` 警告。",
  "",
  "### 汇总行（typeline）",
  "",
  "每次咨询 / 头脑风暴结束后，logger 会输出一行 `[summary]` 汇总（仅进日志，**绝不写入返回报告**）：",
  "",
  "```text",
  "[summary] consult cards=3 ok=2 failed=1 avg_ms=1842 total_ms=4021",
  "[summary] brainstorm rounds=2 turns=4 summary=yes ok=4 failed=0 total_ms=9375",
  "```",
  "",
  "consult 行：`cards`=实际咨询卡数，`ok`/`failed`=成功 / 失败条数，`avg_ms`=平均时长，`total_ms`=总时长。brainstorm 行：`rounds`=轮数，`turns`=对话条数，`summary`=是否产出总结，`ok`/`failed`=成功 / 失败条数，`total_ms`=总时长。",
  "",
  "### 错误压缩",
  "",
  "当**全部**角色卡都咨询失败时，返回报告会压缩为**一条**失败项：文案形如",
  "",
  "```text",
  "全部 3 张卡咨询失败（均为 provider 调用失败）: [首个错误摘要]",
  "```",
  "",
  "首个错误匹配超时（`超时` / `timed out` / `timeout` / `TimedOut`）时追加 `（含超时）`。部分失败不压缩，各失败项原样保留。",
  "",
  "",
].join("\n");

const idx = text.indexOf(anchor);
if (idx < 0) {
  console.error("ERR: 未找到锚点 '## 工具用法'");
  process.exit(1);
}

const out = text.slice(0, idx) + section + text.slice(idx);
writeFileSync(file, out);
console.log("OK: 已插入 日志与诊断 小节");