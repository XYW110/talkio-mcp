# P3 机制来源（摘自归档研究）

## P3-A 多轮运行取并集（agent-review-panel `--runs 3`）
- 轮换人设/匿名别名跑 N 遍，去重合并发现项，输出稳定性评分 `[K/N RUNS]`（K = 提到该发现的轮数）。
- 价值：单轮议事受随机性影响大；多轮并集降低漏检、并以稳定性标注区分「共识结论」与「单轮孤例」。
- 来源全档：`../../archive/2026-09/09-13-council-enhancement/research/competitor-deep-dive.md` §4。

## P3-C Provider 预设（PAL MCP「有凭据即激活」的轻量版）
- PAL：`.env` 有凭据的 provider 自动激活，覆盖 9+ provider。
- 本项目轻量化：不做自动激活，只在 admin ProvidersPage 提供内置预设一键填充 baseUrl/type/apiKeyEnv 提示，降低手写端点出错成本。
