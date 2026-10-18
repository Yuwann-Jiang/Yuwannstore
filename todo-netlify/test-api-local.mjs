// 本地集成测试：不需要部署、不需要网络，直接跑 api.js 的真实路由
//
// 做法：
//   1. 把 netlify/functions/api.js 与 lib/*.js 复制到一个临时目录；
//   2. 在临时目录里放一个内存版 @netlify/blobs 替身（Node 按目录逐级
//      查找 node_modules，所以只有这样才不会动到项目里真正安装的包）；
//   3. import 复制出来的 api.js，用真实 Request 对象打各个接口。
//
// 为什么要复制而不是直接 import 项目里的 api.js：
//   直接 import 会解析到项目 node_modules 里真正的 @netlify/blobs，
//   而它需要 Netlify 运行时上下文（siteID / token），本地跑不起来。
//
// 运行：node test-api-local.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
let pass = 0;
let fail = 0;

async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log("  ✓ " + name);
  } catch (e) {
    fail++;
    console.log("  ✗ " + name + "\n      " + (e && e.message));
  }
}

// ---------------------------------------------------------------------------
// 1. 准备临时工作目录
// ---------------------------------------------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "todo-api-test-"));
fs.mkdirSync(path.join(tmp, "netlify", "functions"), { recursive: true });
fs.mkdirSync(path.join(tmp, "lib"), { recursive: true });

fs.copyFileSync(
  path.join(ROOT, "netlify", "functions", "api.js"),
  path.join(tmp, "netlify", "functions", "api.js")
);
for (const f of fs.readdirSync(path.join(ROOT, "lib"))) {
  fs.copyFileSync(path.join(ROOT, "lib", f), path.join(tmp, "lib", f));
}

// ---------------------------------------------------------------------------
// 2. 内存版 @netlify/blobs
// ---------------------------------------------------------------------------
const blobsDir = path.join(tmp, "node_modules", "@netlify", "blobs");
fs.mkdirSync(blobsDir, { recursive: true });
fs.writeFileSync(
  path.join(blobsDir, "package.json"),
  JSON.stringify({ name: "@netlify/blobs", version: "0.0.0-test", type: "module", main: "index.js" })
);
fs.writeFileSync(
  path.join(blobsDir, "index.js"),
  `
const stores = new Map();

export function getStore({ name = "default" } = {}) {
  if (!stores.has(name)) stores.set(name, new Map());
  const data = stores.get(name);

  return {
    async get(key, opts = {}) {
      if (!data.has(key)) return null;
      const raw = data.get(key);
      // 模拟 { type: "json" } —— 返回深拷贝，避免调用方改到"数据库"里的对象
      if (opts.type === "json" || opts.type === undefined) return JSON.parse(raw);
      return raw;
    },
    async setJSON(key, value) {
      data.set(key, JSON.stringify(value));
    },
    async set(key, value) {
      data.set(key, typeof value === "string" ? value : String(value));
    },
    async delete(key) {
      data.delete(key);
    },
    async list({ prefix = "" } = {}) {
      return { blobs: [...data.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) };
    },
  };
}
`
);

const { default: handler } = await import(
  pathToFileURL(path.join(tmp, "netlify", "functions", "api.js")).href
);

// ---------------------------------------------------------------------------
// 3. 请求工具
// ---------------------------------------------------------------------------
let token = "";

async function call(method, apiPath, { body, auth = true } = {}) {
  const headers = {};
  const init = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  if (auth && token) headers["Authorization"] = "Bearer " + token;

  const res = await handler(new Request("https://example.com" + apiPath, init));
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* .ics 等非 JSON 响应 */ }
  return { status: res.status, json, text, headers: res.headers };
}

const DAY = 24 * 60 * 60 * 1000;
const DEADLINE = Date.now() + 2 * 60 * 60 * 1000; // 2 小时后
const USER = "localtest" + String(Date.now()).slice(-6);

// ---------------------------------------------------------------------------
console.log("\n[启动与鉴权]");
await t("未登录访问统计接口返回 401", async () => {
  const r = await call("GET", "/api/stats");
  assert.equal(r.status, 401);
});
await t("未登录访问日历导出返回 401", async () => {
  const r = await call("GET", "/api/calendar.ics");
  assert.equal(r.status, 401);
});
await t("注册可以拿到 token", async () => {
  const r = await call("POST", "/api/register", { body: { username: USER, password: "secret123" } });
  assert.ok(r.status === 200 || r.status === 201, "状态码 " + r.status);
  assert.ok(r.json.token, "没有返回 token");
  token = r.json.token;
});

console.log("\n[统计接口]");
await t("空账号的统计结构完整", async () => {
  const r = await call("GET", "/api/stats");
  assert.equal(r.status, 200);
  const s = r.json;
  assert.equal(s.active.total, 0);
  assert.equal(s.done.total, 0);
  assert.equal(s.done.onTimeRate, null);
  assert.equal(s.days, 90);
  assert.equal(s.daily.length, 90);
  assert.equal(s.weekday.length, 7);
  assert.equal(s.hourly.length, 24);
  assert.ok(s.range.from < s.range.to);
});

await t("days 参数生效", async () => {
  const r = await call("GET", "/api/stats?days=30");
  assert.equal(r.json.days, 30);
  assert.equal(r.json.daily.length, 30);
});

await t("tz 参数生效（不同时区切天不同）", async () => {
  const a = await call("GET", "/api/stats?tz=480");
  const b = await call("GET", "/api/stats?tz=0");
  assert.equal(a.json.tzMinutes, 480);
  assert.equal(b.json.tzMinutes, 0);
});

console.log("\n[日历导出]");
await t("空账号返回合法 .ics", async () => {
  const r = await call("GET", "/api/calendar.ics");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /text\/calendar/);
  assert.match(r.headers.get("content-disposition"), /attachment/);
  assert.ok(r.text.startsWith("BEGIN:VCALENDAR\r\n"));
  assert.ok(r.text.trimEnd().endsWith("END:VCALENDAR"));
  assert.equal(r.text.includes("BEGIN:VEVENT"), false);
});

console.log("\n[新增待办]");
let todoId = "";
await t("新增返回 id 与列表", async () => {
  const r = await call("POST", "/api/todos", { body: { text: "本地测试任务", deadline: DEADLINE } });
  assert.equal(r.status, 201);
  assert.ok(r.json.todo.id);
  assert.equal(r.json.todos.length, 1);
  todoId = r.json.todo.id;
});

await t("统计里出现在 24 小时内档", async () => {
  const r = await call("GET", "/api/stats");
  assert.equal(r.json.active.total, 1);
  assert.equal(r.json.active.within1d, 1);
});

await t("日历里出现 1 个带提醒的事件", async () => {
  const r = await call("GET", "/api/calendar.ics");
  assert.equal((r.text.match(/BEGIN:VEVENT/g) || []).length, 1);
  assert.ok(r.text.includes("SUMMARY:本地测试任务"));
  assert.ok(r.text.includes("TRIGGER:-P1D"));
  assert.ok(r.text.includes("UID:" + todoId + "@yuwann-todo"));
  // 每行不超过 75 字节
  for (const line of r.text.split("\r\n")) {
    assert.ok(Buffer.byteLength(line, "utf8") <= 75, "行超长: " + line);
  }
});

console.log("\n[完成 → 撤销]");
let completionId = null;
await t("完成待办返回可撤销所需信息", async () => {
  const r = await call("DELETE", "/api/todos/" + todoId);
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.todos.length, 0);
  assert.equal(r.json.completionRecorded, true);
  assert.equal(r.json.completedTodo.text, "本地测试任务");
  assert.ok(r.json.completionId, "缺少 completionId");
  completionId = r.json.completionId;
});

await t("完成记录已落库", async () => {
  const r = await call("GET", "/api/completions");
  assert.equal(r.status, 200);
  assert.equal(r.json.completions.length, 1);
  assert.equal(r.json.completions[0].id, completionId);
  assert.equal(r.json.completions[0].onTime, true); // 截止时间在未来
});

await t("统计反映了这次完成", async () => {
  const r = await call("GET", "/api/stats");
  assert.equal(r.json.done.total, 1);
  assert.equal(r.json.done.inRange, 1);
  assert.equal(r.json.done.onTime, 1);
  assert.equal(r.json.done.onTimeRate, 1);
  assert.equal(r.json.streak.current, 1);
  assert.equal(r.json.daily[r.json.daily.length - 1].count, 1);
});

await t("撤销把待办放回列表并回滚完成记录", async () => {
  const r = await call("POST", "/api/todos/restore", {
    body: { todo: { id: todoId, text: "本地测试任务", deadline: DEADLINE }, completionId },
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.todos.length, 1);
  assert.equal(r.json.todos[0].id, todoId);
  assert.equal(r.json.completionRolledBack, true);
});

await t("完成记录与统计同步回滚", async () => {
  const c = await call("GET", "/api/completions");
  assert.equal(c.json.completions.length, 0);
  const s = await call("GET", "/api/stats");
  assert.equal(s.json.done.total, 0);
  assert.equal(s.json.active.total, 1);
  assert.equal(s.json.streak.current, 0);
});

await t("重复撤销返回 409", async () => {
  const r = await call("POST", "/api/todos/restore", {
    body: { todo: { id: todoId, text: "本地测试任务", deadline: DEADLINE }, completionId },
  });
  assert.equal(r.status, 409);
});

await t("非法 id 返回 400", async () => {
  const r = await call("POST", "/api/todos/restore", {
    body: { todo: { id: "a b;d", text: "x", deadline: DEADLINE } },
  });
  assert.equal(r.status, 400);
});

await t("缺 todo 字段返回 400", async () => {
  const r = await call("POST", "/api/todos/restore", { body: {} });
  assert.equal(r.status, 400);
});

await t("不带 completionId 也能撤销", async () => {
  const del = await call("DELETE", "/api/todos/" + todoId);
  assert.equal(del.status, 200);
  const r = await call("POST", "/api/todos/restore", {
    body: { todo: { id: todoId, text: "本地测试任务", deadline: DEADLINE } },
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.completionRolledBack, false); // 没给 id，不回滚
  // 注意：上一步的完成记录还在，这是预期行为（接口只回滚明确指定的那条）
});

console.log("\n[编辑待办]");
await t("改名称与时间都会生效", async () => {
  const next = DEADLINE + 3 * DAY;
  const r = await call("PATCH", "/api/todos/" + todoId, {
    body: { text: "改过的名字", deadline: next },
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.todo.text, "改过的名字");
  assert.equal(r.json.todo.deadline, next);
  assert.ok(r.json.todo.updatedAt, "缺少 updatedAt");
});

await t("改截止时间后统计分档跟着变", async () => {
  const s = await call("GET", "/api/stats");
  assert.equal(s.json.active.within1d, 0);
  assert.equal(s.json.active.within3d + s.json.active.within7d, 1);
});

await t("空文本被拒", async () => {
  const r = await call("PATCH", "/api/todos/" + todoId, { body: { text: "   " } });
  assert.equal(r.status, 400);
});

await t("不存在的待办 404", async () => {
  const r = await call("PATCH", "/api/todos/deadbeef", { body: { text: "x" } });
  assert.equal(r.status, 404);
});

console.log("\n[其它接口未被破坏]");
await t("/api/me 正常", async () => {
  const r = await call("GET", "/api/me");
  assert.equal(r.status, 200);
  assert.equal(r.json.username, USER);
});

await t("/api/notify-status 正常（未配置邮件时应为 false）", async () => {
  const r = await call("GET", "/api/notify-status", { auth: false });
  assert.equal(r.status, 200);
  assert.equal(typeof r.json.configured, "boolean");
});

await t("未知接口 404", async () => {
  const r = await call("GET", "/api/nope");
  assert.equal(r.status, 404);
});

await t("登出后 token 失效", async () => {
  const out = await call("POST", "/api/logout");
  assert.equal(out.status, 200);
  const r = await call("GET", "/api/todos");
  assert.equal(r.status, 401);
});

// ---------------------------------------------------------------------------
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n结果：${pass} 通过，${fail} 失败\n`);
process.exit(fail ? 1 : 0);
