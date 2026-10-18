// 本地测试：用模拟存储 + 模拟邮件器，验证「到期提醒」的核心判定逻辑
// 不需要真实邮箱凭据，也不依赖 Netlify 环境。
//
// 运行：node test-notify.mjs
import { runNotify, renderEmail } from "./lib/notify.js";

let pass = 0, fail = 0;
function chk(name, actual, expect) {
  const ok = JSON.stringify(actual) === JSON.stringify(expect);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}   (实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expect)})`);
  ok ? pass++ : fail++;
}

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();

// ---------------------------------------------------------------------------
// 模拟 Netlify Blobs 存储
// ---------------------------------------------------------------------------
function makeStore(seed) {
  const data = new Map(Object.entries(seed).map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]));
  return {
    _data: data,
    async list({ prefix } = {}) {
      const keys = [...data.keys()].filter((k) => !prefix || k.startsWith(prefix));
      return { blobs: keys.map((k) => ({ key: k })) };
    },
    async get(key) {
      return data.has(key) ? JSON.parse(JSON.stringify(data.get(key))) : null;
    },
    async setJSON(key, value) {
      data.set(key, JSON.parse(JSON.stringify(value)));
    },
  };
}

// 模拟邮件器
function makeMailer({ failOn = [] } = {}) {
  const sent = [];
  return {
    sent,
    async sendMail(msg) {
      if (failOn.includes(msg.to)) throw new Error("模拟发送失败: " + msg.to);
      sent.push(msg);
    },
  };
}

// ---------------------------------------------------------------------------
// 准备测试数据
// ---------------------------------------------------------------------------
function seedData() {
  return {
    // 用户 A：已绑定邮箱，三条待办（>1天 / <1天 / 已超时）
    "user:alice": { salt: "s", hash: "h", createdAt: NOW, email: "alice@qq.com" },
    "todos:alice": [
      { id: "a1", text: "三天后的任务", deadline: NOW + 3 * DAY, created: NOW },
      { id: "a2", text: "五小时后的任务", deadline: NOW + 5 * 3600 * 1000, created: NOW },
      { id: "a3", text: "已超时的任务", deadline: NOW - 2 * 3600 * 1000, created: NOW },
    ],
    // 用户 B：已绑定邮箱，但只有远期任务
    "user:bob": { salt: "s", hash: "h", createdAt: NOW, email: "bob@qq.com" },
    "todos:bob": [
      { id: "b1", text: "十天后的任务", deadline: NOW + 10 * DAY, created: NOW },
    ],
    // 用户 C：未绑定邮箱，有紧急任务（不应发信）
    "user:carol": { salt: "s", hash: "h", createdAt: NOW },
    "todos:carol": [
      { id: "c1", text: "紧急但未绑邮箱", deadline: NOW + 3600 * 1000, created: NOW },
    ],
  };
}

const appUrl = "https://yuwann-todo.netlify.app/";

// ---------------------------------------------------------------------------
console.log("=== 1. 首次运行：识别应提醒的待办并发送 ===");
{
  const store = makeStore(seedData());
  const mailer = makeMailer();
  const r = await runNotify({ store, mailer, from: "me@qq.com", appUrl, now: NOW });

  chk("扫描到已绑邮箱的用户数", r.scannedUsers, 2);      // alice + bob
  chk("扫描的待办总数", r.scannedTodos, 4);              // alice3 + bob1（carol 未绑邮箱被跳过）
  chk("判定应提醒的数量", r.due, 2);                     // alice 的 a2 + a3
  chk("成功发送数量", r.sent, 2);
  chk("发送失败数量", r.failed, 0);
  chk("实际发出的收件人", mailer.sent.map((m) => m.to), ["alice@qq.com", "alice@qq.com"]);
  chkTrue("邮件含超时提示", mailer.sent.some((m) => m.subject.includes("已超时")));
  chkTrue("邮件含即将到期提示", mailer.sent.some((m) => m.subject.includes("即将到期")));
  chkTrue("未给未绑邮箱的 carol 发信", !mailer.sent.some((m) => m.to.includes("carol")));

  const aliceTodos = await store.get("todos:alice");
  chk("a2 已标记为已提醒", aliceTodos.find((t) => t.id === "a2").notified, true);
  chk("a3 已标记为已提醒", aliceTodos.find((t) => t.id === "a3").notified, true);
  chk("a1（远期）未被标记", !!aliceTodos.find((t) => t.id === "a1").notified, false);
}

console.log("\n=== 2. 再次运行：不应重复发送 ===");
{
  const store = makeStore(seedData());
  const mailer = makeMailer();
  await runNotify({ store, mailer, from: "me@qq.com", appUrl, now: NOW });
  const first = mailer.sent.length;
  const r2 = await runNotify({ store, mailer, from: "me@qq.com", appUrl, now: NOW + 60000 });
  chk("第一次发送 2 封", first, 2);
  chk("第二次不再发送", r2.sent, 0);
  chk("第二次总发送量仍为 2", mailer.sent.length, 2);
}

console.log("\n=== 3. dry-run：只报告不发送、不标记 ===");
{
  const store = makeStore(seedData());
  const mailer = makeMailer();
  const r = await runNotify({ store, mailer, from: "me@qq.com", appUrl, now: NOW, dryRun: true });
  chk("dry-run 判定应提醒数量", r.due, 2);
  chk("dry-run 未真正发送", r.sent, 0);
  chk("dry-run 未调用邮件器", mailer.sent.length, 0);
  const aliceTodos = await store.get("todos:alice");
  chk("dry-run 未标记 notified", !!aliceTodos.find((t) => t.id === "a2").notified, false);
}

console.log("\n=== 4. 发送失败：不标记，下次会重试 ===");
{
  const store = makeStore(seedData());
  const mailer = makeMailer({ failOn: ["alice@qq.com"] });
  const r = await runNotify({ store, mailer, from: "me@qq.com", appUrl, now: NOW });
  chk("失败数量", r.failed, 2);
  chk("成功数量", r.sent, 0);
  const aliceTodos = await store.get("todos:alice");
  chk("失败后未标记 notified（可重试）", !!aliceTodos.find((t) => t.id === "a2").notified, false);

  // 换一个正常邮件器再跑一次，应当补发成功
  const mailer2 = makeMailer();
  const r2 = await runNotify({ store, mailer: mailer2, from: "me@qq.com", appUrl, now: NOW + 1000 });
  chk("重试后发送成功", r2.sent, 2);
}

console.log("\n=== 5. 未配置邮件服务时的行为 ===");
{
  const store = makeStore(seedData());
  const r = await runNotify({ store, mailer: null, from: "me@qq.com", appUrl, now: NOW });
  chkTrue("返回明确错误提示", typeof r.error === "string" && r.error.includes("未配置"));
  chk("未发送任何邮件", r.sent, 0);
}

console.log("\n=== 6. 边界：恰好剩余 24 小时 ===");
{
  const store = makeStore({
    "user:edge": { salt: "s", hash: "h", createdAt: NOW, email: "edge@qq.com" },
    "todos:edge": [{ id: "e1", text: "正好一天", deadline: NOW + DAY, created: NOW }],
  });
  const mailer = makeMailer();
  const r = await runNotify({ store, mailer, from: "me@qq.com", appUrl, now: NOW });
  chk("恰好 24 小时即触发（含边界）", r.sent, 1);
}

console.log(`\n===== 结果: 通过 ${pass} 项, 失败 ${fail} 项 =====`);
process.exit(fail === 0 ? 0 : 1);

function chkTrue(name, cond, extra = "") {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${extra ? "   " + extra : ""}`);
  cond ? pass++ : fail++;
}
