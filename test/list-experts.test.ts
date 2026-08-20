import { describe, expect, it } from "vitest";
import type { AppConfig, ExpertConfig } from "../src/types.js";
import {
  handleListExperts,
  selectListedExperts,
  summarizeExpert,
} from "../src/tools/list-experts.js";

function makeExpert(
  id: string,
  overrides: Partial<ExpertConfig> = {},
): ExpertConfig {
  return {
    id,
    name: `专家-${id}`,
    icon: "🤖",
    systemPrompt: `你是 ${id}，这段提示词不应出现在 list_experts 输出里。`,
    provider: "openai",
    model: "test-model",
    temperature: 0.7,
    maxTokens: 1024,
    timeoutMs: 5000,
    enabled: true,
    ...overrides,
  };
}

function makeConfig(experts: ExpertConfig[]): AppConfig {
  return {
    providers: {
      openai: {
        type: "openai",
        baseUrl: "https://example.invalid",
        apiKeyEnv: "TEST_KEY",
      },
    },
    experts,
  };
}

describe("list_experts 发现工具", () => {
  it("默认只返回启用专家，且不含 systemPrompt", async () => {
    const config = makeConfig([
      makeExpert("architect"),
      makeExpert("legacy", { enabled: false }),
    ]);
    const selected = selectListedExperts(config);
    expect(selected.map((e) => e.id)).toEqual(["architect"]);

    const result = await handleListExperts({}, config);
    const text = result.content[0] && "text" in result.content[0]
      ? result.content[0].text
      : "";
    expect(text).toContain("architect");
    expect(text).not.toContain("legacy");
    expect(text).not.toContain("这段提示词不应出现");
    expect(summarizeExpert(config.experts[0]!).id).toBe("architect");
  });

  it("includeDisabled=true 时包含未启用专家", async () => {
    const config = makeConfig([
      makeExpert("architect"),
      makeExpert("legacy", { enabled: false }),
    ]);
    const result = await handleListExperts({ includeDisabled: true }, config);
    const text = result.content[0] && "text" in result.content[0]
      ? result.content[0].text
      : "";
    expect(text).toContain("legacy");
    expect(text).toContain("disabled");
  });
});
