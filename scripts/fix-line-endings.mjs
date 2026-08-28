#!/usr/bin/env node
/**
 * fix-line-endings.mjs — 将指定 TS 源文件统一为 LF 行尾、无 BOM（UTF-8）。
 *
 * 背景：Windows 下源文件原为 CRLF；filesystem 编辑工具插入 LF 行后文件出现
 * CRLF/LF 混合。本脚本将整个文件重写为纯 LF，避免行尾混杂。逐文件读取原始
 * 字节，用 Buffer 判断是否带 BOM；统一写成无 BOM 的 UTF-8 + LF。
 *
 * 用法：node scripts/fix-line-endings.mjs <file...>
 */

import { readFile, writeFile } from "node:fs/promises";

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("用法: node scripts/fix-line-endings.mjs <file...>");
  process.exit(1);
}

for (const file of files) {
  const raw = await readFile(file);
  let text = raw.toString("utf8");
  // 去除 BOM 标记（\uFEFF），统一写回无 BOM。
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  // 归一化 CRLF / CR → LF。
  const normalized = text.replace(/\r\n?/g, "\n");
  await writeFile(file, normalized, { encoding: "utf8" });
  console.error(`normalized: ${file}`);
}

console.error("done");