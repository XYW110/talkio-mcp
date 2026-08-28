/**
 * 隐私脱敏工具（隐私层，design 补充）。
 *
 * 三层策略：
 * 1. 协议层：调用方 agent 在调用 MCP 前，把姓名/地名/精确地址等无规律 PII
 *    替换为占位符（如 [人名]、[地名]）。工具 description 里已写明该约定。
 * 2. 规则层：本模块对手机号/身份证/邮箱/银行卡/微信等有明确格式的 PII 做
 *    正则兜底掩码 —— 即使调用方忘记替换，发往 LLM 的内容也已脱敏。
 * 3. 错误层：错误信息 / 日志中回显的用户输入同样经过掩码，避免二次泄漏。
 *
 * 掩码采用「克制」策略：只替换明显是 PII 的 token 为语义占位符，保留文章
 * 结构，尽量不影响专家对问题的理解（占位符自解释）。
 */

/** 手机号：1 开头、第二位 3-9、共 11 位数字，前后不能是数字/字母。 */
const PHONE_RE = /(?<![A-Za-z0-9])1[3-9]\d{9}(?![A-Za-z0-9])/g;
/** 身份证：18 位，末位可为 X/x，前后边界。 */
const ID_CARD_RE = /(?<![A-Za-z0-9])\d{17}[\dXx](?![A-Za-z0-9])/g;
/** 邮箱：标准 user@domain.tld。 */
const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
/** 银行卡：16-19 位纯数字，前后边界（下限 16 位以降低误伤订单号/时间戳）。 */
const BANKCARD_RE = /(?<![A-Za-z0-9])\d{16,19}(?![A-Za-z0-9])/g;
/** 微信号 / vx / weixin 后跟随的账号（字母数字下划线横线）。保留前缀文字，只替换账号。 */
const WEIXIN_RE =
  /((?:微信|weixin|vx|VX|wx)号?[:：\s]*)[A-Za-z0-9_-]{4,}/gi;

const PII_RULES: Array<{
  label: string;
  re: RegExp;
  /** 命中时保留前置文字（如微信/weixin/vx 前缀），只替换账号本体。 */
  preservePrefix?: boolean;
}> = [
  { label: "[手机号]", re: PHONE_RE },
  { label: "[身份证号]", re: ID_CARD_RE },
  { label: "[邮箱]", re: EMAIL_RE },
  { label: "[银行卡号]", re: BANKCARD_RE },
  { label: "[微信号]", re: WEIXIN_RE, preservePrefix: true },
];

/** 对一段文本做规则化 PII 掩码。返回掩码后的文本。 */
export function redactPII(text: string): string {
  let out = text;
  for (const { label, re, preservePrefix } of PII_RULES) {
    if (preservePrefix) {
      // WEIXIN_RE 带前缀捕获组，回调首参数即前缀。
      out = out.replace(re, (_match, prefix: string) => `${prefix}${label}`);
    } else {
      // 其余规则整体替换为标签；label 不含 `$`，字符串替换安全。
      out = out.replace(re, label);
    }
  }
  return out;
}

/**
 * 错误信息专用脱敏：在规则化 PII 掩码之外，保留错误的核心内容。
 * 使用场景：provider 抛错、编排器错误回显、格式化错误区块等。
 * 注意：占位符（[人名] / [地名]）本身不是 PII，不会被替换。
 */
export function redactError(text: string): string {
  return redactPII(text);
}