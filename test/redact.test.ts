import { describe, expect, it } from "vitest";
import { redactPII } from "../src/utils/redact.js";

/**
 * 隐私脱敏单元测试。
 * 覆盖：手机号 / 身份证 / 邮箱 / 银行卡 / 微信号 的规则化掩码，
 * 以及「非 PII 普通文本不误伤」的克制性。
 */

describe("redactPII（规则化 PII 掩码）", () => {
  it("掩码大陆手机号（11 位，1 开头第二位 3-9）", () => {
    expect(
      redactPII("请联系我 13812345678 谢谢")
    ).toBe("请联系我 [手机号] 谢谢");
  });

  it("掩码带区号/分隔的号码与 400 等长号不误伤", () => {
    expect(redactPII("号码 1234567 不属于手机号")).toBe(
      "号码 1234567 不属于手机号"
    );
    expect(redactPII("客服 40012345678")).toBe("客服 40012345678");
  });

  it("掩码 18 位身份证（末位 X/x 兼容）", () => {
    expect(
      redactPII("身份证 110101199003074518")
    ).toBe("身份证 [身份证号]");
    expect(
      redactPII("证件号 11010119900307451x 结尾小写")
    ).toBe("证件号 [身份证号] 结尾小写");
  });

  it("掩码邮箱", () => {
    expect(redactPII("我的邮箱 zhangsan@example.com 请回复")).toBe(
      "我的邮箱 [邮箱] 请回复"
    );
  });

  it("掩码银行卡（16-19 位连续数字，避免误伤时间戳/订单号）", () => {
    expect(redactPII("卡号 6222021234567890123")).toBe("卡号 [银行卡号]");
    // 15 位数字不视为银行卡
    expect(redactPII("订单 123456789012345")).toBe("订单 123456789012345");
  });

  it("掩码微信号（微信/weixin/vx/wx 前缀 + 账号）", () => {
    expect(redactPII("微信号 wx_abc12345")).toBe("微信号 [微信号]");
    expect(redactPII("vx: hero_2024")).toBe("vx: [微信号]");
    expect(redactPII("微信：tomcat_88")).toBe("微信：[微信号]");
  });

  it("占位符（[人名]/[地名]）保持原样不二次替换", () => {
    expect(redactPII("问题涉及 [人名] 在 [地名] 的情况")).toBe(
      "问题涉及 [人名] 在 [地名] 的情况"
    );
  });

  it("无 PII 的普通文本原样返回", () => {
    const text =
      "如何设计一个高并发系统？需要考虑缓存、队列与限流，以及分库分表策略。";
    expect(redactPII(text)).toBe(text);
  });

  it("混合场景：一句话里多种 PII 同时掩码", () => {
    const input =
      "张三 13812345678 邮箱 zhangsan@mail.com 住在北京市海淀区";
    const out = redactPII(input);
    expect(out).toBe("张三 [手机号] 邮箱 [邮箱] 住在北京市海淀区");
  });
});