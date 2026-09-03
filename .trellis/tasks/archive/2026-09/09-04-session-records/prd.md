# 会话记录落盘（consult/brainstorm 持久化）

## Goal

consult_experts / brainstorm / brainstorm_followup 三个工具每次调用的完整过程与结果目前只存在于返回值与流式通知中，调用结束即丢失。本任务为三个工具增加**会话级持久化记录**：每次调用生成一个 JSONL 会话文件，落盘元数据、逐卡/逐轮实录与失败原因、token 用量，为后续 admin-web「记录查看页面」提供数据源。

## Requirements

### 功能需求

1. **每次调用生成一个会话记录文件**（`<records 目录>/<会话 id>.jsonl`），三个工具均覆盖：
   - `consult_experts`：问题、上下文、选中卡列表、每张卡的原始回答/失败原因、token 用量、最终报告。
   - `brainstorm`：主题、模式、轮数、选中卡列表、全轮次逐字实录（含缺席标注）、可选总结、token 用量。
   - `brainstorm_followup`：追问问题、传入的历史 turns、降级标记、本轮新 turns、token 用量。
2. **记录内容四要素**（用户已确认 ABCD 全选）：
   - A 会话元数据：时间、工具名、问题/主题、上下文、选中卡（卡 id/名称/专家/模型/provider）。
   - B 每张卡完整原始回答 + 失败项与失败原因。
   - C brainstorm 全轮次逐字实录。
   - D 模型用量：promptTokens / completionTokens（provider 上报才记录，缺省不造假）。
3. **对主流程零影响**：记录写入的任何失败（磁盘满、目录不可写等）只允许 warn 日志，绝不影响工具调用本身。
4. **隐私边界与现有约定一致**：记录的是已脱敏后的内容（redactPII 之后的数据），不额外引入新泄露面。

### 配置需求

5. 默认开启；`TALKIO_RECORDS=0` 可关闭。
6. 目录默认 `<experts.json 所在目录>/records`，可用 `TALKIO_RECORDS_DIR` 覆盖。
7. `records/` 加入 `.gitignore`。

### 查询接口需求（为后续页面准备，本期不做 UI）

8. admin API 新增：
   - `GET /api/records?limit=N` — 按时间倒序的会话列表（meta 摘要）。
   - `GET /api/records/:id` — 单会话完整 JSONL 内容。

### 非目标

- 不做 admin-web 页面 UI（用户明确「后面我再做页面」）。
- 不做记录检索/全文搜索/删除接口。
- 不改 MCP 工具的对外契约（返回值结构不变；`DialogueTurn` 新增的 `usage` 为可选输出字段，followup 输入侧 zod 会自然剥离多余键，无破坏）。

## Acceptance Criteria

- [ ] Mock 模式下三个工具各调用一次，`records/` 下各生成一个合法 JSONL 文件，包含 meta 行、事件行、done 行。
- [ ] 记录含每张卡的成功回答或失败原因；brainstorm 含全轮次实录与（开启时的）总结。
- [ ] consult 记录含 provider 上报的 usage；brainstorm/followup 轮次记录 usage（askExpert 扩展后）。
- [ ] records 目录不可写时工具照常返回，仅 stderr 出现 warn。
- [ ] `TALKIO_RECORDS=0` 时不产生任何文件。
- [ ] `GET /api/records` 与 `GET /api/records/:id` 返回预期数据；未知 id 返回 404。
- [ ] `npm run typecheck`、`npm test` 全部通过。

## Notes

- 用户已确认方案：JSONL 落盘（Q2 A）；内容 ABCD 全存（Q3）。
- 数据可得性调研：consult 的 `ConsultationItem` 已带 `usage`；`askExpert` 目前丢弃 usage，需扩展返回 `{content, usage}`。
