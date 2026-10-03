import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, resolveProviderCredentials } from "../src/config.js";
import type { KeysStore } from "../src/keys/store.js";
import { fillKeys, installKeysStore } from "./helpers/keys.js";

/**
 * config.ts 契约（见 design.md §3/§7 与任务书）：
 *   loadConfig(configPath?: string): Promise<AppConfig>
 *   - 读取 experts.json，zod 校验三段结构（providers / experts / models / cards）
 *   - 旧格式（defaults.provider/model 或 expert 带 provider/model）自动迁移并写回，
 *     写前复制 .bak 备份
 *   - 引用完整性：cards→experts/models、models→providers 缺失时 exit(1)
 *   - cards/models/experts 为空 → exit(1)
 *   - 渠道密钥从进程级 keys store（keys.json）惰性解析；
 *     experts.json 遗留 apiKeyEnv 字段宽容忽略（0.2.0 回滚兼容）
 */

/** 构造一份合法的三段式 experts.json fixture（design.md §3 模板） */
function makeValidExpertsJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    providers: {
      openai: {
        type: "openai",
        baseUrl: "https://api.openai.com/v1",
        apiKeyEnv: "OPENAI_API_KEY",
      },
      anthropic: {
        type: "anthropic",
        baseUrl: "https://api.anthropic.com",
        apiKeyEnv: "ANTHROPIC_API_KEY",
      },
    },
    experts: [
      {
        id: "architect",
        name: "架构师",
        icon: "🏛️",
        systemPrompt: "你是一位资深软件架构师",
        temperature: 0.7,
        maxTokens: 2048,
        timeoutMs: 120000,
        enabled: true,
      },
      {
        id: "security",
        name: "安全专家",
        icon: "🔒",
        systemPrompt: "你是一位应用安全专家",
        temperature: 0.5,
        maxTokens: 2048,
        timeoutMs: 120000,
        enabled: true,
      },
    ],
    models: [
      {
        id: "openai-gpt-4o",
        providerId: "openai",
        modelId: "gpt-4o",
        displayName: "GPT-4o",
        enabled: true,
      },
      {
        id: "anthropic-claude-sonnet-4-20250514",
        providerId: "anthropic",
        modelId: "claude-sonnet-4-20250514",
        displayName: "Claude Sonnet 4",
        enabled: true,
      },
    ],
    cards: [
      {
        id: "architect-openai-gpt-4o",
        name: "架构师 · GPT-4o",
        expertId: "architect",
        modelId: "openai-gpt-4o",
        enabled: true,
        isDefault: true,
      },
      {
        id: "security-anthropic-claude-sonnet-4-20250514",
        name: "安全专家 · Claude Sonnet 4",
        expertId: "security",
        modelId: "anthropic-claude-sonnet-4-20250514",
        enabled: true,
      },
    ],
    ...overrides,
  });
}

/** 旧格式 experts.json fixture（带 defaults + 专家带 provider/model） */
function makeLegacyExpertsJson(): string {
  return JSON.stringify({
    defaults: {
      provider: "openai",
      model: "gpt-4o-mini",
      temperature: 0.7,
      maxTokens: 2048,
      timeoutMs: 120000,
    },
    providers: {
      openai: {
        type: "openai",
        baseUrl: "https://api.openai.com/v1",
        apiKeyEnv: "OPENAI_API_KEY",
      },
      anthropic: {
        type: "anthropic",
        baseUrl: "https://api.anthropic.com",
        apiKeyEnv: "ANTHROPIC_API_KEY",
      },
    },
    experts: [
      {
        id: "architect",
        name: "架构师",
        icon: "🏛️",
        systemPrompt: "你是一位资深软件架构师",
        provider: "openai",
        model: "gpt-4o",
        enabled: true,
      },
      {
        id: "security",
        name: "安全专家",
        icon: "🔒",
        systemPrompt: "你是一位应用安全专家",
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        temperature: 0.5,
        enabled: true,
      },
    ],
  });
}

describe("loadConfig", () => {
  let workDir: string;
  let keys: KeysStore;

  // loadConfig 校验失败时 process.exit(1)；测试中 mock 掉以避免杀死 vitest 进程
  const exitMock = vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`process.exit(${code})`);
  });

  function writeFixture(content: string, fileName = "experts.json"): string {
    const filePath = join(workDir, fileName);
    writeFileSync(filePath, content, "utf-8");
    return filePath;
  }

  beforeEach(async () => {
    workDir = mkdtempSync(join(tmpdir(), "talkio-config-test-"));
    // 注入空密钥池并预置两个渠道 key（替代旧的 env fixture）
    keys = installKeysStore();
    await fillKeys(keys, { openai: "sk-test-openai", anthropic: "sk-**************" });
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  describe("合法三段配置", () => {
    it("加载合法 experts.json 返回三段结构", async () => {
      const config = await loadConfig(writeFixture(makeValidExpertsJson()));

      expect(config.providers).toHaveProperty("openai");
      expect(config.experts.map((e) => e.id)).toEqual(["architect", "security"]);
      expect(config.models.map((m) => m.id)).toEqual([
        "openai-gpt-4o",
        "anthropic-claude-sonnet-4-20250514",
      ]);
      expect(config.cards.map((c) => c.id)).toEqual([
        "architect-openai-gpt-4o",
        "security-anthropic-claude-sonnet-4-20250514",
      ]);
    });

    it("专家不包含 provider/model（解绑）", async () => {
      const config = await loadConfig(writeFixture(makeValidExpertsJson()));
      const architect = config.experts.find((e) => e.id === "architect");

      expect(architect).toBeDefined();
      expect(architect).not.toHaveProperty("provider");
      expect(architect).not.toHaveProperty("model");
      expect(architect!.temperature).toBe(0.7);
      expect(architect!.maxTokens).toBe(2048);
    });

    it("cards 引用与 experts/models 对应", async () => {
      const config = await loadConfig(writeFixture(makeValidExpertsJson()));
      const card = config.cards[0]!;

      expect(card.expertId).toBe("architect");
      expect(card.modelId).toBe("openai-gpt-4o");
      expect(card.isDefault).toBe(true);
      const model = config.models.find((m) => m.id === card.modelId);
      expect(model!.modelId).toBe("gpt-4o");
      expect(model!.providerId).toBe("openai");
    });
  });

  describe("reasoningStrategy（P1-B，council-enhancement）", () => {
    it("合法枚举值加载通过；缺省字段不出现在解析产物中", async () => {
      const raw = JSON.parse(makeValidExpertsJson()) as {
        experts: Array<{ id: string; reasoningStrategy?: string }>;
      };
      raw.experts[0]!.reasoningStrategy = "adversarial";
      const config = await loadConfig(writeFixture(JSON.stringify(raw)));

      expect(config.experts[0]!.reasoningStrategy).toBe("adversarial");
      // 旧 experts.json（无该字段）可加载，且 zod 产物不新增缺省键
      expect(config.experts[1]).not.toHaveProperty("reasoningStrategy");
    });

    it("非法枚举值报校验错误", async () => {
      const raw = JSON.parse(makeValidExpertsJson()) as {
        experts: Array<{ id: string; reasoningStrategy?: string }>;
      };
      raw.experts[0]!.reasoningStrategy = "chaotic";
      await expect(loadConfig(writeFixture(JSON.stringify(raw)))).rejects.toThrow();
    });
  });

  describe("signals / tier / disabledTools（task 09-13-council-enhancement-p2）", () => {
    it("卡 signals 合法值加载通过；缺省不出键（旧文件直接加载）", async () => {
      const raw = JSON.parse(makeValidExpertsJson()) as {
        cards: Array<{ id: string; signals?: string[] }>;
      };
      raw.cards[0]!.signals = ["sql-data", "general"];
      const config = await loadConfig(writeFixture(JSON.stringify(raw)));

      expect(config.cards[0]!.signals).toEqual(["sql-data", "general"]);
      expect(config.cards[1]).not.toHaveProperty("signals");
    });

    it("卡 signals 含非法信号组时报校验错误", async () => {
      const raw = JSON.parse(makeValidExpertsJson()) as {
        cards: Array<{ id: string; signals?: string[] }>;
      };
      raw.cards[0]!.signals = ["not-a-signal"];
      await expect(loadConfig(writeFixture(JSON.stringify(raw)))).rejects.toThrow();
    });

    it("模型 tier 合法正整数加载通过；非法值拒绝；缺省不出键", async () => {
      const raw = JSON.parse(makeValidExpertsJson()) as {
        models: Array<{ id: string; tier?: number }>;
      };
      raw.models[0]!.tier = 3;
      const config = await loadConfig(writeFixture(JSON.stringify(raw)));

      expect(config.models[0]!.tier).toBe(3);
      expect(config.models[1]).not.toHaveProperty("tier");

      for (const bad of [0, -1, 1.5, 101]) {
        const broken = JSON.parse(makeValidExpertsJson()) as {
          models: Array<{ id: string; tier?: number }>;
        };
        broken.models[0]!.tier = bad;
        await expect(
          loadConfig(writeFixture(JSON.stringify(broken)))
        ).rejects.toThrow();
      }
    });

    it("disabledTools 缺省不出键；禁用 brainstorm_followup 合法", async () => {
      const baseline = await loadConfig(writeFixture(makeValidExpertsJson()));
      expect(baseline).not.toHaveProperty("disabledTools");

      const raw = JSON.parse(makeValidExpertsJson()) as {
        disabledTools?: string[];
      };
      raw.disabledTools = ["brainstorm_followup"];
      const config = await loadConfig(writeFixture(JSON.stringify(raw)));
      expect(config.disabledTools).toEqual(["brainstorm_followup"]);
    });

    it("disabledTools 禁用核心工具时 loadConfig 报错（保护名单）", async () => {
      for (const name of ["list_cards", "consult_experts", "brainstorm"]) {
        const raw = JSON.parse(makeValidExpertsJson()) as {
          disabledTools?: string[];
        };
        raw.disabledTools = [name];
        await expect(
          loadConfig(writeFixture(JSON.stringify(raw)))
        ).rejects.toThrow();
      }
    });

    it("disabledTools 含未知工具名时 loadConfig 报错", async () => {
      const raw = JSON.parse(makeValidExpertsJson()) as {
        disabledTools?: string[];
      };
      raw.disabledTools = ["no_such_tool"];
      await expect(loadConfig(writeFixture(JSON.stringify(raw)))).rejects.toThrow();
    });
  });

  describe("旧格式迁移", () => {
    it("检测到旧格式自动迁移并写回，生成 .bak 备份", async () => {
      const filePath = writeFixture(makeLegacyExpertsJson());
      const config = await loadConfig(filePath);

      // 三段齐全
      expect(config.experts).toHaveLength(2);
      expect(config.models).toHaveLength(2);
      expect(config.cards).toHaveLength(2);

      // 文件已写回新格式
      const written = JSON.parse(readFileSync(filePath, "utf-8"));
      expect(written).not.toHaveProperty("defaults");
      expect(written.models).toHaveLength(2);
      expect(written.cards).toHaveLength(2);

      // 备份存在且为旧格式
      expect(existsSync(`${filePath}.bak`)).toBe(true);
      const backup = JSON.parse(readFileSync(`${filePath}.bak`, "utf-8"));
      expect(backup).toHaveProperty("defaults");
    });

    it("迁移生成的卡 id / 名称符合规则，首张 isDefault", async () => {
      const filePath = writeFixture(makeLegacyExpertsJson());
      const config = await loadConfig(filePath);

      expect(config.cards[0]!.id).toBe("architect-openai-gpt-4o");
expect(config.cards[0]!.name).toBe("架构师 · gpt-4o");
      expect(config.cards[0]!.isDefault).toBe(true);
      expect(config.cards[1]!.isDefault).toBeUndefined();

      // 模型内部 id = ${provider}-${modelSlug}
      expect(config.models.map((m) => m.id)).toEqual([
        "openai-gpt-4o",
        "anthropic-claude-sonnet-4-20250514",
      ]);
      expect(config.models[1]!.modelId).toBe("claude-sonnet-4-20250514");
    });

    it("缺失 temperature 的专家从 defaults 兜底", async () => {
      const filePath = writeFixture(makeLegacyExpertsJson());
      const config = await loadConfig(filePath);

      const architect = config.experts.find((e) => e.id === "architect");
      expect(architect!.temperature).toBe(0.7); // 来自 defaults
      const security = config.experts.find((e) => e.id === "security");
      expect(security!.temperature).toBe(0.5); // 专家自身覆盖
      expect(security!.maxTokens).toBe(2048); // defaults
      expect(security!.timeoutMs).toBe(120000); // defaults
    });

    it("迁移幂等：迁移后的新格式文件再次 loadConfig 不再迁移", async () => {
      const filePath = writeFixture(makeLegacyExpertsJson());
      await loadConfig(filePath);
      const sizeAfterFirst = readFileSync(filePath, "utf8").length;

      // 第二次加载不会再次写盘（文件内容不变）
      await loadConfig(filePath);
      const sizeAfterSecond = readFileSync(filePath, "utf8").length;
      expect(sizeAfterSecond).toBe(sizeAfterFirst);
    });
  });

  describe("引用完整性校验（fail fast）", () => {
    it("cards 引用不存在的专家时抛错", async () => {
      const fixture = makeValidExpertsJson({
        cards: [
          {
            id: "ghost-card",
            name: "幽灵卡",
            expertId: "ghost-expert",
            modelId: "openai-gpt-4o",
            enabled: true,
          },
        ],
      });
      await expect(loadConfig(writeFixture(fixture))).rejects.toThrow(
        "process.exit(1)"
      );
    });

    it("cards 引用不存在的模型时抛错", async () => {
      const fixture = makeValidExpertsJson({
        cards: [
          {
            id: "bad-card",
            name: "坏卡",
            expertId: "architect",
            modelId: "ghost-model",
            enabled: true,
          },
        ],
      });
      await expect(loadConfig(writeFixture(fixture))).rejects.toThrow(
        "process.exit(1)"
      );
    });

    it("models 引用不存在的 provider 时抛错", async () => {
      const fixture = makeValidExpertsJson({
        models: [
          {
            id: "ghost-model",
            providerId: "nonexistent-provider",
            modelId: "gpt-x",
            displayName: "Ghost",
            enabled: true,
          },
        ],
      });
      await expect(loadConfig(writeFixture(fixture))).rejects.toThrow(
        "process.exit(1)"
      );
    });

    it("cards 数组为空时抛错", async () => {
      const fixture = makeValidExpertsJson({ cards: [] });
      await expect(loadConfig(writeFixture(fixture))).rejects.toThrow(
        "process.exit(1)"
      );
    });

    it("experts 数组为空时抛错", async () => {
      const fixture = makeValidExpertsJson({ experts: [] });
      await expect(loadConfig(writeFixture(fixture))).rejects.toThrow();
    });

    it("id 重复时抛错", async () => {
      const fixture = makeValidExpertsJson({
        cards: [
          makeValidExpertsJsonCards()[0],
          makeValidExpertsJsonCards()[0],
        ],
      });
      await expect(loadConfig(writeFixture(fixture))).rejects.toThrow(
        "process.exit(1)"
      );
    });

    it("JSON 语法损坏时抛错", async () => {
      await expect(
        loadConfig(writeFixture("{ not valid json !!!"))
      ).rejects.toThrow();
    });

    it("配置文件不存在时抛错", async () => {
      const missing = join(workDir, "does-not-exist.json");
      await expect(loadConfig(missing)).rejects.toThrow();
    });
  });

  describe("渠道密钥解析（keys store）", () => {
    it("provider 的 apiKey 从 keys store 惰性解析（不读环境变量）", async () => {
      // fixture 的 apiKeyEnv 指向 "OPENAI_API_KEY"，但该环境变量不存在——
      // 解析成功即证明新代码不读 env，密钥只来自 keys store
      const config = await loadConfig(writeFixture(makeValidExpertsJson()));

      // 契约：apiKey 不在 loadConfig 返回的 AppConfig 上暴露；
      // 通过 resolveProviderCredentials(config, providerName) 惰性解析
      const creds = resolveProviderCredentials(config, "openai");
      expect(creds.apiKey).toBe("sk-test-openai");
    });

    it("keys store 更新后重新解析得到新值（热生效）", async () => {
      const config = await loadConfig(writeFixture(makeValidExpertsJson()));

      expect(resolveProviderCredentials(config, "openai").apiKey).toBe(
        "sk-test-openai"
      );

      await keys.set("openai", "sk-second");
      expect(resolveProviderCredentials(config, "openai").apiKey).toBe(
        "sk-second"
      );
    });

    it("渠道未配置 key 时 resolveProviderCredentials 抛错（missing key 指引后台）", async () => {
      await keys.set("openai", ""); // 清除
      const config = await loadConfig(writeFixture(makeValidExpertsJson()));

      // 契约（design.md §7）：惰性解析缺失 key 时 throw（调用时 card 报错）
      expect(() => resolveProviderCredentials(config, "openai")).toThrow(
        /missing key/
      );
    });

    it("遗留 apiKeyEnv 字段宽容忽略：非法变量名也能加载", async () => {
      const raw = JSON.parse(makeValidExpertsJson()) as {
        providers: Record<string, { apiKeyEnv?: string }>;
      };
      raw.providers["openai"]!.apiKeyEnv = "not a valid env name";
      const config = await loadConfig(writeFixture(JSON.stringify(raw)));
      expect(resolveProviderCredentials(config, "openai").apiKey).toBe(
        "sk-test-openai"
      );
    });
  });
});

/** 从合法 fixture 提取 cards 数组（用于 id 重复测试） */
function makeValidExpertsJsonCards(): Array<Record<string, unknown>> {
  return (
    JSON.parse(makeValidExpertsJson()) as { cards: Array<Record<string, unknown>> }
  ).cards;
}