import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

/**
 * config.ts 契约（见 design.md §4 与任务书）：
 *   loadConfig(configPath?: string): AppConfig
 *   - 读取 experts.json，zod 校验
 *   - defaults 合并进每个 expert（expert 级字段覆盖 defaults）
 *   - providers[name].apiKeyEnv 指定环境变量名，key 从 process.env 解析
 *   - 缺必填字段 / 引用不存在的 provider → 抛错（fail fast）
 */

/** 构造一份合法的 experts.json fixture（基于 design.md §4 模板精简） */
function makeValidExpertsJson(overrides: Record<string, unknown> = {}): string {
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
        enabled: true,
      },
    ],
    ...overrides,
  });
}

describe("loadConfig", () => {
  let workDir: string;
  /** 本测试 touched 的环境变量，afterEach 统一还原 */
  const touchedEnvKeys = new Set<string>();
  const originalEnv = { ...process.env };

  function setEnv(key: string, value: string | undefined): void {
    touchedEnvKeys.add(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  function writeFixture(content: string, fileName = "experts.json"): string {
    const filePath = join(workDir, fileName);
    writeFileSync(filePath, content, "utf-8");
    return filePath;
  }

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "talkio-config-test-"));
    // 保证测试所需的 key 环境变量存在
    setEnv("OPENAI_API_KEY", "sk-test-openai");
    setEnv("ANTHROPIC_API_KEY", "sk-test-anthropic");
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
    // 还原 env：删除本测试新增、恢复被覆盖的值
    for (const key of touchedEnvKeys) {
      if (key in originalEnv) {
        process.env[key] = originalEnv[key];
      } else {
        delete process.env[key];
      }
    }
    touchedEnvKeys.clear();
  });

  describe("合法配置", () => {
    it("加载合法 experts.json 成功并返回 experts/providers/defaults", () => {
      const config = loadConfig(writeFixture(makeValidExpertsJson()));

      expect(config.experts).toHaveLength(2);
      expect(config.providers).toHaveProperty("openai");
      expect(config.providers).toHaveProperty("anthropic");
      expect(config.defaults).toBeDefined();
    });

    it("defaults 合并：expert 未指定的字段继承 defaults", () => {
      const fixture = makeValidExpertsJson({
        experts: [
          {
            id: "minimal",
            name: "极简专家",
            icon: "🤖",
            systemPrompt: "test prompt",
            // 不指定 provider/model/temperature/maxTokens/timeoutMs
            enabled: true,
          },
        ],
      });
      const config = loadConfig(writeFixture(fixture));
      const expert = config.experts.find((e) => e.id === "minimal");

      expect(expert).toBeDefined();
      expect(expert!.provider).toBe("openai");
      expect(expert!.model).toBe("gpt-4o-mini");
      expect(expert!.temperature).toBe(0.7);
      expect(expert!.maxTokens).toBe(2048);
      expect(expert!.timeoutMs).toBe(120000);
    });

    it("defaults 合并：expert 级字段覆盖 defaults", () => {
      const config = loadConfig(writeFixture(makeValidExpertsJson()));
      const architect = config.experts.find((e) => e.id === "architect");

      // fixture 中 architect 显式指定了 provider/model
      expect(architect!.provider).toBe("openai");
      expect(architect!.model).toBe("gpt-4o");
      // 未显式指定的 temperature 继承 defaults
      expect(architect!.temperature).toBe(0.7);
    });
  });

  describe("校验失败（fail fast）", () => {
    it("expert 缺必填字段（如 systemPrompt）时抛错", () => {
      const fixture = makeValidExpertsJson({
        experts: [
          {
            id: "broken",
            name: "残缺专家",
            icon: "❌",
            // 缺 systemPrompt
            provider: "openai",
            enabled: true,
          },
        ],
      });
      expect(() => loadConfig(writeFixture(fixture))).toThrow();
    });

    it("expert 引用不存在的 provider 时抛错", () => {
      const fixture = makeValidExpertsJson({
        experts: [
          {
            id: "ghost",
            name: "幽灵专家",
            icon: "👻",
            systemPrompt: "prompt",
            provider: "nonexistent-provider",
            enabled: true,
          },
        ],
      });
      expect(() => loadConfig(writeFixture(fixture))).toThrow(/provider/i);
    });

    it("experts 数组为空时抛错", () => {
      const fixture = makeValidExpertsJson({ experts: [] });
      expect(() => loadConfig(writeFixture(fixture))).toThrow();
    });

    it("JSON 语法损坏时抛错", () => {
      expect(() => loadConfig(writeFixture("{ not valid json !!!"))).toThrow();
    });

    it("配置文件不存在时抛错", () => {
      const missing = join(workDir, "does-not-exist.json");
      expect(() => loadConfig(missing)).toThrow();
    });
  });

  describe("apiKeyEnv 环境变量解析", () => {
    it("provider 的 apiKey 从 apiKeyEnv 指定的环境变量解析", () => {
      setEnv("OPENAI_API_KEY", "sk-resolved-key-12345");
      const config = loadConfig(writeFixture(makeValidExpertsJson()));

      // 契约：AppConfig 中 provider 解析后应能拿到 key。
      // 假设 AppConfig.providers[name] 上暴露解析后的 apiKey 字段
      // （若实现改为惰性解析，本断言需调整为触发 adapter 调用后检查）。
      const openai = config.providers.openai as Record<string, unknown>;
      expect(openai.apiKey).toBe("sk-resolved-key-12345");
    });

    it("修改环境变量后重新 loadConfig 解析到新值", () => {
      setEnv("OPENAI_API_KEY", "sk-first");
      const first = loadConfig(writeFixture(makeValidExpertsJson()));

      setEnv("OPENAI_API_KEY", "sk-second");
      const second = loadConfig(writeFixture(makeValidExpertsJson()));

      expect((first.providers.openai as Record<string, unknown>).apiKey).toBe("sk-first");
      expect((second.providers.openai as Record<string, unknown>).apiKey).toBe("sk-second");
    });

    it("apiKeyEnv 对应的环境变量缺失时不把 undefined 当作合法 key", () => {
      setEnv("OPENAI_API_KEY", undefined);
      const config = loadConfig(writeFixture(makeValidExpertsJson()));
      const openai = config.providers.openai as Record<string, unknown>;

      // 契约（design.md §7）：缺 key 惰性失败（调用时 expert 报错），
      // 启动只 warn 不 fail —— 因此 loadConfig 不应抛错，但 apiKey 不应是有效字符串
      expect(openai.apiKey == null || openai.apiKey === "").toBe(true);
    });
  });
});
