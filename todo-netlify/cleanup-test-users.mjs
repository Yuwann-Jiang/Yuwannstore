#!/usr/bin/env node
// 清理测试账号（默认只预览，不删除）
//
// 为什么需要它：历次接口测试（test-features.sh / todo-deno/test.sh 等）都会注册
// 一批形如 feat1792293069 / deno1790773071 的临时账号，它们会出现在管理员后台的
// 用户列表里，干扰查看真实用户。
//
// 安全设计：只匹配「前缀 + 10 位时间戳」这种自动生成的命名，
// 任何看起来像真实用户名的账号（包括中文名、短名字）都不会被删。
//
// 用法：
//   node cleanup-test-users.mjs              # 只列出会被删除的账号
//   node cleanup-test-users.mjs --apply      # 真正执行删除
//
// 实现说明：直接用 @netlify/blobs SDK（显式传 siteID + token），
// **不要**用 `netlify blobs:delete` CLI —— 每个 key 都要启一次 CLI 进程，
// 删 100 多个 key 要好几分钟，中途超时还会留下删一半的状态。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getStore } from "@netlify/blobs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// 「自动生成的测试账号」= 前缀 + 10 位秒级时间戳
const PATTERN = /^(deno|denob|feat|hm|edit|e2e|diag|probe|fix|mail|mailtest|np|pw|redir|sc|localtest)[0-9]{10}$/;

function readToken() {
  if (process.env.NETLIFY_AUTH_TOKEN) return process.env.NETLIFY_AUTH_TOKEN.trim();
  const p = path.join(HERE, ".netlify-token");
  if (fs.existsSync(p)) return fs.readFileSync(p, "utf8").trim();
  throw new Error("找不到 Netlify 令牌：请设置 NETLIFY_AUTH_TOKEN 或创建 .netlify-token");
}

function readSiteId() {
  if (process.env.NETLIFY_SITE_ID) return process.env.NETLIFY_SITE_ID.trim();
  const p = path.join(HERE, ".netlify", "state.json");
  if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8")).siteId;
  throw new Error("找不到站点 ID：请设置 NETLIFY_SITE_ID");
}

const apply = process.argv.includes("--apply");

const store = getStore({ name: "todo-app", siteID: readSiteId(), token: readToken() });

console.log("== 读取账号列表 ==");
const { blobs } = await store.list({ prefix: "user:" });
const users = blobs.map((b) => b.key.slice("user:".length));
const targets = users.filter((u) => PATTERN.test(u)).sort();
const keep = users.filter((u) => !PATTERN.test(u)).sort();

if (targets.length === 0) {
  console.log("没有匹配到测试账号，无需清理。");
  process.exit(0);
}

console.log("\n== 将被清理（" + targets.length + " 个）==");
for (const u of targets) console.log("  - " + u);

console.log("\n== 保留不动（" + keep.length + " 个）==");
for (const u of keep) console.log("  · " + u);

if (!apply) {
  console.log("\n以上为预览。确认无误后加 --apply 真正删除：");
  console.log("  node cleanup-test-users.mjs --apply");
  process.exit(0);
}

console.log("\n== 开始删除 ==");
let fail = 0;
for (const u of targets) {
  for (const key of ["user:" + u, "todos:" + u, "completions:" + u]) {
    try {
      await store.delete(key);
    } catch (e) {
      console.log("  ! 删除失败 " + key + "：" + (e && e.message));
      fail++;
    }
  }
  console.log("  ✓ 已清理 " + u);
}

console.log(
  fail ? "\n有 " + fail + " 个 key 删除失败，请检查网络或权限。" : "\n全部清理完成。"
);
process.exit(fail ? 1 : 0);
