// 统计模块自测：node test-stats.mjs
// 覆盖：时区切天、准时率、连续天数、窗口、分布、边界情况

import assert from "node:assert/strict";
import { computeStats, dayKey, dayStartMs, weekStartOf, DEFAULT_TZ_MINUTES } from "./lib/stats.js";

const DAY = 24 * 60 * 60 * 1000;
const TZ = 480; // 北京
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

// 构造"北京时间"某天某点的时间戳
function bj(y, mo, d, h = 0, mi = 0) {
  return Date.parse(
    `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}T` +
      `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}:00+08:00`
  );
}

const NOW = bj(2026, 10, 20, 15, 0); // 北京时间 2026-10-20 15:00

console.log("\n[时区]");
t("北京时间凌晨算当天，不算前一天", () => {
  assert.equal(dayKey(bj(2026, 10, 20, 0, 30), TZ), "2026-10-20");
  assert.equal(dayKey(bj(2026, 10, 20, 0, 30), 0), "2026-10-19"); // 换成 UTC 切天就错位了
});
t("dayStartMs 与 dayKey 互逆", () => {
  const start = dayStartMs("2026-10-20", TZ);
  assert.equal(dayKey(start, TZ), "2026-10-20");
  assert.equal(dayKey(start + 23 * 3600000, TZ), "2026-10-20");
  assert.equal(dayKey(start - 1, TZ), "2026-10-19");
});
t("weekStartOf 返回周一", () => {
  assert.equal(weekStartOf("2026-10-20"), "2026-10-19"); // 周二 → 周一
  assert.equal(weekStartOf("2026-10-19"), "2026-10-19"); // 周一 → 自己
  assert.equal(weekStartOf("2026-10-25"), "2026-10-19"); // 周日 → 上一个周一
});
t("默认时区是北京", () => {
  assert.equal(DEFAULT_TZ_MINUTES, 480);
});

console.log("\n[空数据]");
t("全零且不抛异常", () => {
  const s = computeStats({ todos: [], completions: [], now: NOW, days: 30 });
  assert.equal(s.active.total, 0);
  assert.equal(s.done.total, 0);
  assert.equal(s.done.onTimeRate, null);
  assert.equal(s.streak.current, 0);
  assert.equal(s.streak.longest, 0);
  assert.equal(s.streak.bestDay, null);
  assert.equal(s.daily.length, 30);
  assert.deepEqual(s.weekday, [0, 0, 0, 0, 0, 0, 0]);
  assert.equal(s.lead.averageMs, null);
  assert.equal(s.average.busiestWeekday, null);
});

console.log("\n[完成与准时]");
const comps = [
  // 按时：截止 10-20 12:00，12:00 完成
  { id: "a", text: "写周报", at: bj(2026, 10, 20, 12), deadline: bj(2026, 10, 20, 12), onTime: true },
  // 超时：截止 10-19 09:00，11:00 才完成
  { id: "b", text: "交材料", at: bj(2026, 10, 19, 11), deadline: bj(2026, 10, 19, 9), onTime: false },
  // 老记录只有 at，没有 deadline / onTime
  { id: "c", text: "旧记录", at: bj(2026, 10, 18, 20) },
  // 老记录有 at + deadline，可推断准时
  { id: "d", text: "可推断", at: bj(2026, 10, 18, 8), deadline: bj(2026, 10, 18, 23) },
];

t("准时 / 超时 / 未知三分", () => {
  const s = computeStats({ todos: [], completions: comps, now: NOW, days: 90 });
  assert.equal(s.done.total, 4);
  assert.equal(s.done.onTime, 2); // a 显式 true，d 推断 true
  assert.equal(s.done.late, 1); // b
  assert.equal(s.done.unknown, 1); // c
  assert.equal(s.done.onTimeRate, 2 / 3); // 只按可判断的记录算
  assert.equal(s.done.lateRate, 1 / 3);
});

t("每日桶把不同类型的完成分开计数", () => {
  const s = computeStats({ todos: [], completions: comps, now: NOW, days: 90 });
  const d20 = s.daily.find((d) => d.date === "2026-10-20");
  const d19 = s.daily.find((d) => d.date === "2026-10-19");
  assert.equal(d20.count, 1 + 0, "10-20 只有 a");
  assert.equal(d20.onTime, 1);
  assert.equal(d19.count, 1);
  assert.equal(d19.late, 1);
});

console.log("\n[连续天数]");
t("今天有完成 → 连续 1 天", () => {
  const s = computeStats({
    todos: [],
    completions: [{ at: bj(2026, 10, 20, 9), onTime: true }],
    now: NOW,
  });
  assert.equal(s.streak.current, 1);
});

t("今天还没完成不打断昨天起的连续", () => {
  const s = computeStats({
    todos: [],
    completions: [
      { at: bj(2026, 10, 19, 9), onTime: true },
      { at: bj(2026, 10, 18, 9), onTime: true },
    ],
    now: NOW,
  });
  assert.equal(s.streak.current, 2);
});

t("中间断一天就归零", () => {
  const s = computeStats({
    todos: [],
    completions: [
      { at: bj(2026, 10, 19, 9) },
      { at: bj(2026, 10, 17, 9) }, // 缺 10-18
    ],
    now: NOW,
  });
  assert.equal(s.streak.current, 1);
});

t("最长连续天数跨出统计窗口也能算对", () => {
  const many = [];
  for (let i = 0; i < 10; i++) many.push({ at: bj(2026, 9, 1 + i, 9) }); // 9-01 ~ 9-10
  const s = computeStats({ todos: [], completions: many, now: NOW, days: 7 });
  assert.equal(s.streak.longest, 10);
  assert.equal(s.streak.current, 0);
});

t("同一天多条不会把连续数加倍", () => {
  const s = computeStats({
    todos: [],
    completions: [
      { at: bj(2026, 10, 20, 9) },
      { at: bj(2026, 10, 20, 10) },
      { at: bj(2026, 10, 20, 11) },
    ],
    now: NOW,
  });
  assert.equal(s.streak.current, 1);
  assert.equal(s.streak.bestDay.count, 3);
});

console.log("\n[时间窗口]");
t("窗口外的完成不计入 inRange，但计入 total", () => {
  const s = computeStats({
    todos: [],
    completions: [{ at: bj(2026, 1, 1, 9) }, { at: bj(2026, 10, 20, 9) }],
    now: NOW,
    days: 7,
  });
  assert.equal(s.done.total, 2);
  assert.equal(s.done.inRange, 1);
  assert.equal(s.daily.length, 7);
});
t("daily 最后一天是今天，第一天是 from", () => {
  const s = computeStats({ todos: [], completions: [], now: NOW, days: 7 });
  assert.equal(s.daily[s.daily.length - 1].date, "2026-10-20");
  assert.equal(s.daily[0].date, "2026-10-14");
  assert.equal(s.range.from, "2026-10-14");
  assert.equal(s.range.to, "2026-10-20");
});
t("days 越界会被夹住", () => {
  assert.equal(computeStats({ now: NOW, days: 0 }).days, 1);
  assert.equal(computeStats({ now: NOW, days: 9999 }).days, 365);
  assert.equal(computeStats({ now: NOW, days: undefined }).days, 90);
});

console.log("\n[当前待办分布]");
const todos = [
  { id: "1", text: "已超时", deadline: NOW - 3600000, created: NOW - 3 * DAY },
  { id: "2", text: "12 小时后", deadline: NOW + 12 * 3600000, created: NOW - DAY },
  { id: "3", text: "2 天后", deadline: NOW + 2 * DAY, created: NOW - DAY },
  { id: "4", text: "5 天后", deadline: NOW + 5 * DAY, created: NOW },
  { id: "5", text: "30 天后", deadline: NOW + 30 * DAY, created: NOW },
  { id: "6", text: "没有截止时间", deadline: NaN },
];

t("按剩余时间分桶", () => {
  const s = computeStats({ todos, completions: [], now: NOW, days: 90 });
  assert.equal(s.active.total, 5); // 非法截止时间的那条被忽略
  assert.equal(s.active.overdue, 1);
  assert.equal(s.active.within1d, 1);
  assert.equal(s.active.within3d, 1);
  assert.equal(s.active.within7d, 1);
  assert.equal(s.active.later, 1);
});

t("计划提前量只统计合法待办", () => {
  const s = computeStats({
    todos: [{ id: "x", deadline: NOW + 10 * DAY, created: NOW }],
    now: NOW,
  });
  assert.equal(s.lead.count, 1);
  assert.equal(s.lead.averageMs, 10 * DAY);
  assert.equal(s.lead.medianMs, 10 * DAY);
});

console.log("\n[分布]");
t("星期与小时按本地时间统计", () => {
  // 2026-10-20 是周二
  const s = computeStats({
    todos: [],
    completions: [{ at: bj(2026, 10, 20, 23, 30) }],
    now: NOW,
    days: 90,
  });
  assert.equal(s.weekday[2], 1); // 周二
  assert.equal(s.hourly[23], 1); // 本地 23 点，用 UTC 会算成 15 点
  assert.equal(s.average.busiestWeekday, 2);
  assert.equal(s.average.busiestHour, 23);
});

t("按周汇总", () => {
  const s = computeStats({
    todos: [],
    completions: [
      { at: bj(2026, 10, 19, 9) }, // 周一，本周
      { at: bj(2026, 10, 20, 9) }, // 周二，本周
      { at: bj(2026, 10, 14, 9) }, // 上周三
    ],
    now: NOW,
    days: 90,
  });
  const cur = s.weekly.find((w) => w.weekStart === "2026-10-19");
  const prev = s.weekly.find((w) => w.weekStart === "2026-10-12");
  assert.equal(cur.count, 2);
  assert.equal(prev.count, 1);
});

t("空完成记录不产生 bestDay", () => {
  const s = computeStats({ todos: [], completions: [], now: NOW, days: 30 });
  assert.equal(s.streak.bestDay, null);
  assert.equal(s.average.perActiveDay, 0);
});

t("脏数据不炸", () => {
  const s = computeStats({
    todos: [null, undefined, {}, { deadline: "abc" }, { deadline: NOW }],
    completions: [null, {}, { at: "x" }, { at: Infinity }],
    now: NOW,
  });
  assert.equal(s.active.total, 1);
  assert.equal(s.done.total, 0);
});

console.log(`\n结果：${pass} 通过，${fail} 失败\n`);
process.exit(fail ? 1 : 0);
