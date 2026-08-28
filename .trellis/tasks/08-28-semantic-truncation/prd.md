# 语义截断——长上下文自动摘要压缩

## Goal

当 question/context/对话历史超长时，自动做语义级摘要压缩以贴合模型上下文窗口（区别于硬截断）。需评估触发阈值、摘要触发点（发往 LLM 前）、与 redactPII 的顺序、对咨询/头脑风暴两类编排的影响。

## Requirements

- TBD

## Acceptance Criteria

- [ ] TBD

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
