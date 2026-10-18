// 本地测试：用模拟存储 + 模拟邮件器，验证「多级到期提醒」的判定逻辑
// 不需要真实邮箱凭据，也不依赖 Netlify 环境。
//
// 提醒分三档（见 lib/notify.js 的 STAGES）：
//   3d      剩余 ≤ 3 天
//   1d      剩余 ≤ 1 天
//   overdue 已超过截止时间
// 每档最多发一次；直接跳到更紧急的档位时，会跳过中间档一起标记（不补发）。
//
// 运行：node test-notify.mjs
import { runNotify, renderEmail, currentStage, sentStages, STAGES } from "./lib/notify.js";

let pass = 0, fail = 0;
function chk(name, actual, expect) {
  const ok = JSON.stringify(actual) === JSON.stringify(expect);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}   (实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expect)})`);
  ok ? pass++ : fail++;
}
function chkTrue(name, cond, extra = "") {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${extra ? "   " + extra : ""}`);
  cond ? pass++ : fail++;
}

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-10-20T07:00:00Z");

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

const appUrl = "https://yuwann-todo.netlify.app/";
const FROM = "me@qq.com";

// 用户 alice 的三条待办分别落在三个档位上
function seedData(now = NOW) {
  return {
    "user:alice": { salt: "s", hash: "h", createdAt: now, email: "alice@qq.com" },
    "todos:alice": [
      { id: "a1", text: "三天后的任务", deadline: now + 3 * DAY, created: now },
      { id: "a2", text: "五小时后的任务", deadline: now + 5 * HOUR, created: now },
      { id: "a3", text: "已超时的任务", deadline: now - 2 * HOUR, created: now },
    ],
    // bob 只有远期任务
    "user:bob": { salt: "s", hash: "h", createdAt: now, email: "bob@qq.com" },
    "todos:bob": [{ id: "b1", text: "十天后的任务", deadline: now + 10 * DAY, created: now }],
    // carol 没绑邮箱
    "user:carol": { salt: "s", hash: "h", createdAt: now },
    "todos:carol": [{ id: "c1", text: "紧急但未绑邮箱", deadline: now + HOUR, created: now }],
  };
}

// ---------------------------------------------------------------------------
console.log("=== 0. 档位判定（currentStage）===");
{
  chk("剩余 5 天 → 不提醒", currentStage(5 * DAY), null);
  chk("剩余 3 天整 → 3d（含边界）", currentStage(3 * DAY), "3d");
  chk("剩余 3 天多 1 毫秒 → 不提醒", currentStage(3 * DAY + 1), null);
  chk("剩余 2 天 → 3d", currentStage(2 * DAY), "3d");
  chk("剩余 24 小时整 → 1d（含边界）", currentStage(DAY), "1d");
  chk("剩余 24 小时多 1 毫秒 → 3d", currentStage(DAY + 1), "3d");
  chk("剩余 1 毫秒 → 1d", currentStage(1), "1d");
  chk("剩余 0 → 1d", currentStage(0), "1d");
  chk("剩余 -1 毫秒 → overdue", currentStage(-1), "overdue");
  chk("STAGES 顺序由轻到重", STAGES, ["3d", "1d", "overdue"]);
}

console.log("\n=== 1. 已发档位的读取（含旧数据兼容）===");
{
  chk("新数据：直接读 notifiedStages", sentStages({ notifiedStages: ["3d"] }), ["3d"]);
  chk("旧数据：notified=true 视为 3d+1d 已发", sentStages({ notified: true }), ["3d", "1d"]);
  chk("全新待办：空数组", sentStages({}), []);
  chk("字段类型异常时按空处理", sentStages({ notifiedStages: "3d" }), []);
}

console.log("\n=== 2. 首次运行：三档各发一封 ===");
{
  const store = makeStore(seedData());
  const mailer = makeMailer();
  const r = await runNotify({ store, mailer, from: FROM, appUrl, now: NOW });

  chk("扫描到已绑邮箱的用户数", r.scannedUsers, 2); // alice + bob
  chk("扫描的待办总数", r.scannedTodos, 4); // alice 3 + bob 1（carol 未绑邮箱被跳过）
  chk("判定应提醒的数量", r.due, 3);
  chk("成功发送数量", r.sent, 3);
  chk("发送失败数量", r.failed, 0);
  chk("收件人", mailer.sent.map((m) => m.to), ["alice@qq.com", "alice@qq.com", "alice@qq.com"]);

  chkTrue("有「还有 3 天」的邮件", mailer.sent.some((m) => m.subject.includes("还有 3 天")));
  chkTrue("有「即将到期」的邮件", mailer.sent.some((m) => m.subject.includes("即将到期")));
  chkTrue("有「已超时」的邮件", mailer.sent.some((m) => m.subject.includes("已超时")));
  chkTrue("未给未绑邮箱的 carol 发信", !mailer.sent.some((m) => m.to.includes("carol")));
  chkTrue("远期任务（10 天）没发信", !mailer.sent.some((m) => m.subject.includes("十天后的任务")));

  const alice = await store.get("todos:alice");
  chk("a1 只标记了 3d", alice.find((t) => t.id === "a1").notifiedStages, ["3d"]);
  chk("a2 标记了 3d+1d", alice.find((t) => t.id === "a2").notifiedStages, ["3d", "1d"]);
  chk("a3 三档全部标记（跳过中间档不补发）", alice.find((t) => t.id === "a3").notifiedStages, [
    "3d", "1d", "overdue",
  ]);
  chk("notifiedStage 记录最后一档", alice.find((t) => t.id === "a3").notifiedStage, "overdue");
  chk("notifiedAt 记录发送时间", alice.find((t) => t.id === "a2").notifiedAt, NOW);
  chk("兼容字段 notified 仍为 true", alice.find((t) => t.id === "a2").notified, true);
}

console.log("\n=== 3. 再次运行：不重复发送 ===");
{
  const store = makeStore(seedData());
  const mailer = makeMailer();
  await runNotify({ store, mailer, from: FROM, appUrl, now: NOW });
  const first = mailer.sent.length;
  const r2 = await runNotify({ store, mailer, from: FROM, appUrl, now: NOW + 60000 });
  chk("第一次发送 3 封", first, 3);
  chk("第二次不再发送", r2.sent, 0);
  chk("总发送量仍为 3", mailer.sent.length, 3);
}

console.log("\n=== 4. 时间推进：逐档升级各发一次 ===");
{
  const t0 = NOW;
  const store = makeStore({
    "user:u": { salt: "s", hash: "h", createdAt: t0, email: "u@qq.com" },
    // 5 天后截止，先不提醒
    "todos:u": [{ id: "x", text: "逐步逼近的任务", deadline: t0 + 5 * DAY, created: t0 }],
  });
  const mailer = makeMailer();

  let r = await runNotify({ store, mailer, from: FROM, appUrl, now: t0 });
  chk("第 0 天（剩 5 天）：不发", r.sent, 0);

  r = await runNotify({ store, mailer, from: FROM, appUrl, now: t0 + 2 * DAY }); // 剩 3 天
  chk("第 2 天（剩 3 天）：发 3d", r.sent, 1);
  chk("  阶段正确", mailer.sent[0] && mailer.sent[0].subject.includes("还有 3 天"), true);

  r = await runNotify({ store, mailer, from: FROM, appUrl, now: t0 + 2 * DAY + HOUR });
  chk("第 2 天再过 1 小时：不重复发", r.sent, 0);

  r = await runNotify({ store, mailer, from: FROM, appUrl, now: t0 + 4 * DAY }); // 剩 1 天
  chk("第 4 天（剩 1 天）：发 1d", r.sent, 1);
  chk("  阶段正确", mailer.sent[1] && mailer.sent[1].subject.includes("即将到期"), true);

  r = await runNotify({ store, mailer, from: FROM, appUrl, now: t0 + 6 * DAY }); // 已超时
  chk("第 6 天（超时）：发 overdue", r.sent, 1);
  chk("  阶段正确", mailer.sent[2] && mailer.sent[2].subject.includes("已超时"), true);

  r = await runNotify({ store, mailer, from: FROM, appUrl, now: t0 + 20 * DAY });
  chk("再过 14 天：仍然不发（每档只发一次）", r.sent, 0);
  chk("总共只发了 3 封", mailer.sent.length, 3);

  const saved = (await store.get("todos:u"))[0];
  chk("最终三档都已标记", saved.notifiedStages, ["3d", "1d", "overdue"]);
}

console.log("\n=== 5. 跳档：直接超时只发一封，不补发中间档 ===");
{
  const store = makeStore({
    "user:u": { salt: "s", hash: "h", createdAt: NOW, email: "u@qq.com" },
    "todos:u": [{ id: "x", text: "一觉睡过头", deadline: NOW + 10 * DAY, created: NOW }],
  });
  const mailer = makeMailer();
  // 中间没人跑定时任务，直接跳到超时 1 天
  const r = await runNotify({ store, mailer, from: FROM, appUrl, now: NOW + 11 * DAY });
  chk("只发 1 封", r.sent, 1);
  chk("发的是超时档", mailer.sent[0] && mailer.sent[0].subject.includes("已超时"), true);
  const saved = (await store.get("todos:u"))[0];
  chk("三档一起标记，避免之后补发", saved.notifiedStages, ["3d", "1d", "overdue"]);
}

console.log("\n=== 6. 旧数据兼容：notified=true 的老待办 ===");
{
  const store = makeStore({
    "user:u": { salt: "s", hash: "h", createdAt: NOW, email: "u@qq.com" },
    "todos:u": [
      // 老版本只在"剩不到 1 天"时发过一次 → 视为 3d、1d 已发
      { id: "old", text: "老数据", deadline: NOW + 5 * HOUR, created: NOW, notified: true },
    ],
  });
  const mailer = makeMailer();
  let r = await runNotify({ store, mailer, from: FROM, appUrl, now: NOW });
  chk("仍在 1d 档：不重发", r.sent, 0);

  r = await runNotify({ store, mailer, from: FROM, appUrl, now: NOW + DAY });
  chk("变成超时后：补发 overdue", r.sent, 1);
  chk("  阶段正确", mailer.sent[0] && mailer.sent[0].subject.includes("已超时"), true);
  const saved = (await store.get("todos:u"))[0];
  chk("被升级为数组结构", saved.notifiedStages, ["3d", "1d", "overdue"]);
}

console.log("\n=== 7. dry-run：只报告，不发送也不标记 ===");
{
  const store = makeStore(seedData());
  const mailer = makeMailer();
  const r = await runNotify({ store, mailer, from: FROM, appUrl, now: NOW, dryRun: true });
  chk("dry-run 判定应提醒数量", r.due, 3);
  chk("dry-run 未真正发送", r.sent, 0);
  chk("dry-run 未调用邮件器", mailer.sent.length, 0);
  chk("dry-run 明细带阶段", r.details.map((d) => d.stage), ["3d", "1d", "overdue"]);
  const alice = await store.get("todos:alice");
  chk("dry-run 未写入 notifiedStages", !!alice.find((t) => t.id === "a2").notifiedStages, false);
}

console.log("\n=== 8. 发送失败：不标记，下次重试 ===");
{
  const store = makeStore(seedData());
  const mailer = makeMailer({ failOn: ["alice@qq.com"] });
  const r = await runNotify({ store, mailer, from: FROM, appUrl, now: NOW });
  chk("失败数量", r.failed, 3);
  chk("成功数量", r.sent, 0);
  const alice = await store.get("todos:alice");
  chk("失败后未标记（可重试）", !!alice.find((t) => t.id === "a2").notifiedStages, false);

  const mailer2 = makeMailer();
  const r2 = await runNotify({ store, mailer: mailer2, from: FROM, appUrl, now: NOW + 1000 });
  chk("重试后三封全部成功", r2.sent, 3);
}

console.log("\n=== 9. 未配置邮件服务 ===");
{
  const store = makeStore(seedData());
  const r = await runNotify({ store, mailer: null, from: FROM, appUrl, now: NOW });
  chkTrue("返回明确错误提示", typeof r.error === "string" && r.error.includes("未配置"));
  chk("未发送任何邮件", r.sent, 0);
}

console.log("\n=== 10. 邮件文案随档位变化 ===");
{
  const todo = { id: "t", text: "交房租", deadline: NOW + 5 * HOUR };
  const tpl3d = renderEmail({ todo, remain: 3 * DAY, appUrl, stage: "3d" });
  const tpl1d = renderEmail({ todo, remain: 5 * HOUR, appUrl, stage: "1d" });
  const tplOd = renderEmail({ todo, remain: -2 * HOUR, appUrl, stage: "overdue" });

  chk("3d 主题", tpl3d.subject.includes("还有 3 天"), true);
  chk("1d 主题", tpl1d.subject.includes("即将到期"), true);
  chk("overdue 主题", tplOd.subject.includes("已超时"), true);
  chk("三封邮件主题互不相同", new Set([tpl3d.subject, tpl1d.subject, tplOd.subject]).size, 3);
  chk("邮件里都带上待办名称", [tpl3d, tpl1d, tplOd].every((m) => m.html.includes("交房租")), true);
  chk("邮件里都带应用链接", [tpl3d, tpl1d, tplOd].every((m) => m.html.includes(appUrl)), true);
  chk("都返回 stage", [tpl3d.stage, tpl1d.stage, tplOd.stage], ["3d", "1d", "overdue"]);
  chk("未传 stage 时按剩余时间自动判断", renderEmail({ todo, remain: 2 * DAY, appUrl }).stage, "3d");
  chkTrue(
    "HTML 转义了尖括号",
    renderEmail({ todo: { text: "<script>x</script>", deadline: NOW }, remain: 1, appUrl }).html.includes(
      "&lt;script&gt;"
    )
  );
}

console.log(`\n===== 结果: 通过 ${pass} 项, 失败 ${fail} 项 =====`);
process.exit(fail === 0 ? 0 : 1);
