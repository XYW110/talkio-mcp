import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig, CardConfig } from "../src/types.js";
import {
  SIGNAL_GROUPS,
  SIGNAL_KEYWORDS,
  matchSignals,
  selectCardsBySignals,
} from "../src/tools/signal-routing.js";

/**
 * 信号路由（task 09-13-council-enhancement-p2 / P2-A）契约：
 * - matchSignals：小写化后对 SIGNAL_KEYWORDS 做子串匹配，返回命中信号组（表序）；
 * - selectCardsBySignals：enabled 卡 ∩ (signals 有交集 ∨ 声明 general)，
 *   保持文件序；零命中 → null（由调用方回退默认卡）。
 */

afterEach(() => {
  delete process.env.OPENAI_API_KEY;
  delete process.env.TALKIO_MOCK_PROVIDER;
});

function makeCard(
  id: string,
  overrides: Partial<CardConfig> = {}
): CardConfig {
  return {
    id,
    name: id,
    expertId: "expert",
    modelId: "model",
    enabled: true,
    ...overrides,
  };
}

function configWith(cards: CardConfig[]): AppConfig {
  return {
    providers: {},
    experts: [],
    models: [],
    cards,
  };
}

describe("SIGNAL_GROUPS / SIGNAL_KEYWORDS 常量表", () => {
  it("信号组共 10 组，general 不配置关键词（永不关键词命中）", () => {
    expect(SIGNAL_GROUPS).toHaveLength(10);
    expect(SIGNAL_KEYWORDS.general).toEqual([]);
  });

  it("每组关键词中英文统一小写（子串匹配约定）", () => {
    for (const group of SIGNAL_GROUPS) {
      for (const kw of SIGNAL_KEYWORDS[group]) {
        expect(kw).toBe(kw.toLowerCase());
      }
    }
  });
});

describe("matchSignals", () => {
  it("中文关键词命中", () => {
    expect(matchSignals("这个数据库索引该怎么设计？")).toContain("sql-data");
    expect(matchSignals("如何做好鉴权和权限控制")).toContain("security");
  });

  it("英文关键词大小写不敏感", () => {
    expect(matchSignals("How to optimize this SQL query")).toContain("sql-data");
    expect(matchSignals("K8S 集群部署问题")).toContain("infra");
    expect(matchSignals("Prompt 设计技巧")).toContain("ml");
  });

  it("多组命中保持表序", () => {
    const matched = matchSignals("SQL 注入导致的安全问题");
    expect(matched).toEqual(["sql-data", "security"]);
  });

  it("无命中返回空数组", () => {
    expect(matchSignals("今天天气怎么样")).toEqual([]);
    expect(matchSignals("")).toEqual([]);
  });
});

describe("selectCardsBySignals", () => {
  it("取 signals 与命中信号组有交集的 enabled 卡，保持文件序", () => {
    const config = configWith([
      makeCard("c-architect", { signals: ["sql-data"] }),
      makeCard("c-security", { signals: ["security"] }),
      makeCard("c-ml", { signals: ["ml"] }),
      makeCard("c-nosignal"),
    ]);
    const match = selectCardsBySignals(config, "SQL 注入安全问题");
    expect(match).not.toBeNull();
    expect(match!.matched).toEqual(["sql-data", "security"]);
    expect(match!.cards.map((c) => c.id)).toEqual(["c-architect", "c-security"]);
  });

  it("禁用卡不是候选", () => {
    const config = configWith([
      makeCard("c-architect", { signals: ["sql-data"], enabled: false }),
      makeCard("c-security", { signals: ["sql-data"] }),
    ]);
    const match = selectCardsBySignals(config, "数据库查询优化");
    expect(match!.cards.map((c) => c.id)).toEqual(["c-security"]);
  });

  it("声明 general 的卡任意话题可参与（含零关键词命中）", () => {
    const config = configWith([
      makeCard("c-general", { signals: ["general"] }),
      makeCard("c-architect", { signals: ["sql-data"] }),
    ]);
    // 零关键词命中但存在 general 卡 → 不回退，返回 general 卡
    const fallback = selectCardsBySignals(config, "今天天气怎么样");
    expect(fallback).not.toBeNull();
    expect(fallback!.matched).toEqual([]);
    expect(fallback!.cards.map((c) => c.id)).toEqual(["c-general"]);

    // 有关键词命中时 general 卡与命中卡同时候选
    const mixed = selectCardsBySignals(config, "SQL 怎么优化");
    expect(mixed!.cards.map((c) => c.id)).toEqual(["c-general", "c-architect"]);
  });

  it("零命中（无关键词命中且无 general 卡）→ null", () => {
    const config = configWith([
      makeCard("c-architect", { signals: ["sql-data"] }),
    ]);
    expect(selectCardsBySignals(config, "今天天气怎么样")).toBeNull();
  });

  it("关键词命中但无候选卡（signals 不相交）→ null", () => {
    const config = configWith([
      makeCard("c-architect", { signals: ["frontend"] }),
    ]);
    expect(selectCardsBySignals(config, "SQL 注入")).toBeNull();
  });

  it("空数组 signals 视为未声明", () => {
    const config = configWith([makeCard("c-empty", { signals: [] })]);
    expect(selectCardsBySignals(config, "SQL 优化")).toBeNull();
  });
});
