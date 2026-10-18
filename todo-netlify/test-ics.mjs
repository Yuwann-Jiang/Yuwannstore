// 日历导出（.ics）自测：node test-ics.mjs
// 覆盖：结构、转义、75 字节折行、UTC 时间、提醒开关、脏数据

import assert from "node:assert/strict";
import { buildCalendar, escapeIcsText, foldLine, icsUtc } from "./lib/ics.js";

let pass = 0;
let fail = 0;

function t(name, fn) {
  try {
    fn();
    pass++;
    console.log("  ✓ " + name);
  } catch (e) {
    fail++;
    console.log("  ✗ " + name + "\n      " + (e && e.message));
  }
}

const NOW = Date.parse("2026-10-20T07:00:00Z"); // 北京 15:00
const DEADLINE = Date.parse("2026-10-21T12:00:00Z");

// 把折行的内容还原成"逻辑行"（用于校验内容没被破坏）
function unfold(text) {
  return text
    .split("\r\n")
    .map((line, i) => (i === 0 ? line : line.startsWith(" ") ? line.slice(1) : "\n" + line))
    .join("");
}

function physicalLines(text) {
  return text.split("\r\n").filter((l) => l !== "");
}

console.log("\n[基础结构]");
t("包含 VCALENDAR 头尾与必需属性", () => {
  const ics = buildCalendar({ todos: [{ id: "abc123", text: "写周报", deadline: DEADLINE }], now: NOW });
  assert.ok(ics.startsWith("BEGIN:VCALENDAR\r\n"));
  assert.ok(ics.trimEnd().endsWith("END:VCALENDAR"));
  assert.ok(ics.includes("VERSION:2.0"));
  assert.ok(ics.includes("BEGIN:VEVENT"));
  assert.ok(ics.includes("END:VEVENT"));
  assert.ok(ics.includes("SUMMARY:写周报"));
});

t("行分隔符必须是 CRLF", () => {
  const ics = buildCalendar({ todos: [], now: NOW });
  // 不能出现"孤立的 LF"
  assert.equal(ics.replace(/\r\n/g, "").includes("\n"), false);
});

t("UTC 时间格式正确", () => {
  assert.equal(icsUtc(Date.parse("2026-10-21T12:34:56Z")), "20261021T123456Z");
  const ics = buildCalendar({ todos: [{ id: "a", text: "x", deadline: DEADLINE }], now: NOW });
  assert.ok(ics.includes("DTSTART:20261021T113000Z")); // 截止前 30 分钟
  assert.ok(ics.includes("DTEND:20261021T120000Z")); // 正好是截止时间
  assert.ok(ics.includes("DTSTAMP:20261020T070000Z"));
});

t("没有待办也能生成合法的空日历", () => {
  const ics = buildCalendar({ todos: [], now: NOW });
  assert.ok(ics.includes("BEGIN:VCALENDAR"));
  assert.equal(ics.includes("BEGIN:VEVENT"), false);
});

console.log("\n[转义]");
t("逗号分号反斜杠换行都被转义", () => {
  assert.equal(escapeIcsText("a,b"), "a\\,b");
  assert.equal(escapeIcsText("a;b"), "a\\;b");
  assert.equal(escapeIcsText("a\\b"), "a\\\\b");
  assert.equal(escapeIcsText("a\nb"), "a\\nb");
  assert.equal(escapeIcsText("a\r\nb"), "a\\nb");
});
t("待办里的特殊字符不会破坏结构", () => {
  const ics = buildCalendar({
    todos: [{ id: "a", text: "买牛奶,鸡蛋;顺便\\取快递\n第二行", deadline: DEADLINE }],
    now: NOW,
  });
  assert.ok(ics.includes("SUMMARY:买牛奶\\,鸡蛋\\;顺便\\\\取快递\\n第二行"));
  // 仍然只有一个 VEVENT
  assert.equal(ics.split("BEGIN:VEVENT").length, 2);
});

console.log("\n[折行]");
t("每行不超过 75 字节", () => {
  const long = "把季度总结报告写完并发给张老师和王老师确认后再提交到系统里存档备份一份";
  const ics = buildCalendar({ todos: [{ id: "a", text: long, deadline: DEADLINE }], now: NOW });
  for (const line of physicalLines(ics)) {
    const bytes = Buffer.byteLength(line, "utf8");
    assert.ok(bytes <= 75, `行超长 ${bytes} 字节: ${line}`);
  }
  // 折行不能丢内容
  assert.ok(unfold(ics).includes("SUMMARY:" + long));
});

t("短行不会被折行", () => {
  assert.equal(foldLine("SUMMARY:短"), "SUMMARY:短");
});

t("超长行按 UTF-8 码点切，不劈开中文", () => {
  const text = "中".repeat(40); // 120 字节
  const folded = foldLine("X:" + text);
  const parts = folded.split("\r\n");
  assert.ok(parts.length >= 2);
  for (const p of parts) assert.ok(Buffer.byteLength(p, "utf8") <= 75);
  // 还原后必须完全一致，且没出现替换字符
  assert.equal(parts[0] + parts.slice(1).map((p) => p.slice(1)).join(""), "X:" + text);
  assert.equal(folded.includes("\uFFFD"), false);
});

t("emoji 也不会被劈开", () => {
  const text = "🎉".repeat(30); // 每个 4 字节
  const folded = foldLine(text);
  for (const p of folded.split("\r\n")) {
    assert.ok(Buffer.byteLength(p, "utf8") <= 75);
    assert.equal(p.includes("\uFFFD"), false);
  }
});

console.log("\n[提醒]");
t("默认带提前 1 天的 VALARM", () => {
  const ics = buildCalendar({ todos: [{ id: "a", text: "x", deadline: DEADLINE }], now: NOW });
  assert.ok(ics.includes("BEGIN:VALARM"));
  assert.ok(ics.includes("ACTION:DISPLAY"));
  assert.ok(ics.includes("TRIGGER:-P1D"));
  assert.ok(ics.includes("END:VALARM"));
});
t("alarms=false 时没有 VALARM", () => {
  const ics = buildCalendar({
    todos: [{ id: "a", text: "x", deadline: DEADLINE }],
    now: NOW,
    alarms: false,
  });
  assert.equal(ics.includes("VALARM"), false);
});

console.log("\n[UID 与脏数据]");
t("UID 唯一且只含安全字符", () => {
  const ics = buildCalendar({
    todos: [
      { id: "abc123", text: "一", deadline: DEADLINE },
      { id: "abc124", text: "二", deadline: DEADLINE },
    ],
    now: NOW,
  });
  const uids = ics.split("\r\n").filter((l) => l.startsWith("UID:"));
  assert.equal(uids.length, 2);
  assert.notEqual(uids[0], uids[1]);
  for (const u of uids) assert.ok(/^UID:[A-Za-z0-9_-]+@[A-Za-z0-9.-]+$/.test(u), u);
});

t("非法待办被跳过，不影响其它", () => {
  const ics = buildCalendar({
    todos: [
      null,
      { text: "没有截止时间" },
      { id: "b", text: "没有截止时间", deadline: NaN },
      { id: "c", deadline: DEADLINE }, // 没有 text
      { id: "d", text: "正常", deadline: DEADLINE },
    ],
    now: NOW,
  });
  assert.equal(ics.split("BEGIN:VEVENT").length, 2); // 只剩一条
  assert.ok(ics.includes("SUMMARY:正常"));
});

t("描述里带应用地址", () => {
  const ics = buildCalendar({
    todos: [{ id: "a", text: "x", deadline: DEADLINE }],
    now: NOW,
    appUrl: "https://yuwann-todo.netlify.app/",
  });
  assert.ok(unfold(ics).includes("https://yuwann-todo.netlify.app/"));
  assert.ok(unfold(ics).includes("截止时间：2026-10-21 20:00")); // 北京时间
});

console.log(`\n结果：${pass} 通过，${fail} 失败\n`);
process.exit(fail ? 1 : 0);
