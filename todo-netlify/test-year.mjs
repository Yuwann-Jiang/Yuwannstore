// 年度总结计算自测：node test-year.mjs
//
// 重点验证口径：
//   · 时区：北京时间凌晨完成的不能算到前一天/前一月
//   · 年界：1 月 1 日 00:00 与 12 月 31 日 23:59 都算本年
//   · 空数据、跨年、缺字段的老记录都不能崩

import assert from "node:assert/strict";
import { computeYearReview } from "./lib/year.js";

const TZ = 480; // 北京
const DAY = 86400000;
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

// 北京时间某天某点
function bj(y, mo, d, h = 12, mi = 0) {
  return Date.parse(
    `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}T` +
      `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}:00+08:00`
  );
}

const NOW = bj(2026, 11, 6, 12); // 2026-11-06 12:00 北京

function comp(o) {
  return Object.assign({ id: "c", text: "任务", at: bj(2026, 6, 1), deadline: null, onTime: true }, o);
}

console.log("\n[空数据]");
t("空账号也能生成一份报告", () => {
  const r = computeYearReview({ completions: [], todos: [], memorials: [], year: 2026, now: NOW });
  assert.equal(r.year, 2026);
  assert.equal(r.totals.completed, 0);
  assert.equal(r.totals.onTimeRate, null);
  assert.equal(r.totals.activeDays, 0);
  assert.equal(r.totals.longestStreak, 0);
  assert.equal(r.best.day, null);
  assert.equal(r.best.month, null);
  assert.equal(r.first, null);
  assert.equal(r.last, null);
  assert.equal(r.months.length, 12);
  assert.equal(r.months.every((m) => m.count === 0), true);
  assert.equal(r.compare, null);
  assert.deepEqual(r.milestones, []);
  assert.deepEqual(r.memorials, []);
});

console.log("\n[年界与时区]");
t("1 月 1 日 00:00 算本年", () => {
  const r = computeYearReview({
    completions: [comp({ at: bj(2026, 1, 1, 0, 0) })],
    year: 2026, now: NOW,
  });
  assert.equal(r.totals.completed, 1);
});
t("12 月 31 日 23:59 算本年", () => {
  const r = computeYearReview({
    completions: [comp({ at: bj(2026, 12, 31, 23, 59) })],
    year: 2026, now: NOW,
  });
  assert.equal(r.totals.completed, 1);
});
t("上一年的 12 月 31 日不算本年", () => {
  const r = computeYearReview({
    completions: [comp({ at: bj(2025, 12, 31, 23, 59) })],
    year: 2026, now: NOW,
  });
  assert.equal(r.totals.completed, 0);
});
t("北京时间凌晨 00:30 算当天（不能用 UTC 切天）", () => {
  // 北京 2026-01-01 00:30 = UTC 2025-12-31 16:30，按 UTC 会算到上一年
  const r = computeYearReview({
    completions: [comp({ at: bj(2026, 1, 1, 0, 30) })],
    year: 2026, now: NOW,
  });
  assert.equal(r.totals.completed, 1, "被算到 2025 年去了");
  assert.equal(r.months[0].count, 1, "应算在 1 月");
});

console.log("\n[统计口径]");
t("按月 / 星期 / 时段分布", () => {
  const r = computeYearReview({
    completions: [
      comp({ at: bj(2026, 3, 14, 21) }), // 周六（2026-03-14 是周六）
      comp({ at: bj(2026, 3, 14, 21) }),
      comp({ at: bj(2026, 3, 14, 21) }),
      comp({ at: bj(2026, 3, 20, 9) }),
      comp({ at: bj(2026, 7, 1, 9) }),
    ],
    year: 2026, now: NOW,
  });
  assert.equal(r.totals.completed, 5);
  assert.equal(r.months[2].count, 4); // 3 月
  assert.equal(r.months[6].count, 1); // 7 月
  assert.equal(r.best.month, 3); // 最忙的月份（1-12）
  assert.equal(r.best.day.date, "2026-03-14");
  assert.equal(r.best.day.count, 3);
  assert.equal(r.best.hour, 21);
  assert.equal(r.weekday[6], 3); // 周六
  assert.equal(r.hourly[21], 3);
  assert.equal(r.months[6].count, 1); // 7 月
});
t("准时率只按可判断的记录算", () => {
  const r = computeYearReview({
    completions: [
      comp({ onTime: true }),
      comp({ onTime: true }),
      comp({ onTime: false }),
      comp({ onTime: null }),
    ],
    year: 2026, now: NOW,
  });
  assert.equal(r.totals.onTime, 2);
  assert.equal(r.totals.late, 1);
  assert.equal(r.totals.unknown, 1);
  assert.equal(r.totals.onTimeRate, 2 / 3);
});
t("老记录没有 onTime 但有 at+deadline 也能推断", () => {
  const r = computeYearReview({
    completions: [
      { text: "老记录", at: bj(2026, 5, 1, 10), deadline: bj(2026, 5, 1, 23) },
      { text: "老记录2", at: bj(2026, 5, 2, 10), deadline: bj(2026, 5, 1, 23) },
    ],
    year: 2026, now: NOW,
  });
  assert.equal(r.totals.onTime, 1);
  assert.equal(r.totals.late, 1);
});
t("有记录天数与日均", () => {
  const r = computeYearReview({
    completions: [
      comp({ at: bj(2026, 2, 1) }),
      comp({ at: bj(2026, 2, 1) }),
      comp({ at: bj(2026, 2, 5) }),
    ],
    year: 2026, now: NOW,
  });
  assert.equal(r.totals.activeDays, 2);
  assert.equal(r.totals.perActiveDay, 1.5);
});
t("最长连续天数（年内）", () => {
  const r = computeYearReview({
    completions: [
      comp({ at: bj(2026, 4, 1) }),
      comp({ at: bj(2026, 4, 2) }),
      comp({ at: bj(2026, 4, 3) }),
      comp({ at: bj(2026, 4, 10) }),
    ],
    year: 2026, now: NOW,
  });
  assert.equal(r.totals.longestStreak, 3);
});
t("同一天多条不会把连续天数算多", () => {
  const r = computeYearReview({
    completions: [
      comp({ at: bj(2026, 4, 1, 9) }),
      comp({ at: bj(2026, 4, 1, 10) }),
      comp({ at: bj(2026, 4, 1, 11) }),
    ],
    year: 2026, now: NOW,
  });
  assert.equal(r.totals.longestStreak, 1);
});

console.log("\n[首尾与里程碑]");
t("第一件与最后一件", () => {
  const r = computeYearReview({
    completions: [
      comp({ at: bj(2026, 8, 1), text: "最后" }),
      comp({ at: bj(2026, 2, 1), text: "最早" }),
    ],
    year: 2026, now: NOW,
  });
  assert.equal(r.first.text, "最早");
  assert.equal(r.last.text, "最后");
  assert.equal(r.first.date, "2026-02-01");
});
t("累计第 100 项里程碑", () => {
  const completions = [];
  for (let i = 0; i < 120; i++) {
    completions.push(comp({ at: bj(2026, 3, 1) + i * 1000, text: "任务" + (i + 1) }));
  }
  const r = computeYearReview({ completions, year: 2026, now: NOW });
  const m100 = r.milestones.find((x) => x.n === 100);
  assert.ok(m100, "缺少第 100 项里程碑");
  assert.equal(m100.text, "任务100");
});
t("历史累计截至该年", () => {
  const r = computeYearReview({
    completions: [
      comp({ at: bj(2025, 5, 1) }),
      comp({ at: bj(2026, 5, 1) }),
      comp({ at: bj(2027, 5, 1) }),
    ],
    year: 2026, now: NOW,
  });
  assert.equal(r.totals.historyTotal, 2, "2027 年的不该算进来");
});

console.log("\n[同比]");
t("有上一年数据时给出变化", () => {
  const r = computeYearReview({
    completions: [
      comp({ at: bj(2025, 6, 1), onTime: true }),
      comp({ at: bj(2025, 6, 2), onTime: false }),
      comp({ at: bj(2026, 6, 1), onTime: true }),
      comp({ at: bj(2026, 6, 2), onTime: true }),
      comp({ at: bj(2026, 6, 3), onTime: true }),
    ],
    year: 2026, now: NOW,
  });
  assert.equal(r.compare.prevYear, 2025);
  assert.equal(r.compare.prevCompleted, 2);
  assert.equal(r.compare.completedDelta, 1);
  assert.equal(r.compare.prevOnTimeRate, 0.5);
  assert.equal(Math.round(r.compare.onTimeRateDelta * 100) / 100, 0.5);
});
t("没有上一年数据时为 null", () => {
  const r = computeYearReview({ completions: [comp({})], year: 2026, now: NOW });
  assert.equal(r.compare, null);
});

console.log("\n[待办与纪念日]");
t("只在总结当年时算「还欠着」", () => {
  const todos = [
    { id: "1", deadline: NOW - 10 * DAY },
    { id: "2", deadline: NOW - 3 * DAY },
    { id: "3", deadline: NOW + 5 * DAY },
  ];
  const thisYear = computeYearReview({ todos, year: 2026, now: NOW });
  assert.equal(thisYear.pending.total, 3);
  assert.equal(thisYear.pending.overdue, 2);
  assert.equal(thisYear.pending.oldestOverdueDays, 10);

  const past = computeYearReview({ todos, year: 2025, now: NOW });
  assert.equal(past.pending, null);
});
t("公历纪念日按周年出现", () => {
  const r = computeYearReview({
    memorials: [{ title: "在一起", calendar: "solar", date: "2020-05-20", repeat: "year" }],
    year: 2026, now: NOW,
  });
  assert.equal(r.memorials.length, 1);
  assert.equal(r.memorials[0].solar, "2026-05-20");
  assert.equal(r.memorials[0].years, 6);
});
t("农历纪念日换算成本年后算周年", () => {
  const r = computeYearReview({
    memorials: [{ title: "外婆生日", calendar: "lunar", date: "1940-08-15", repeat: "year" }],
    year: 2026, now: NOW,
  });
  assert.equal(r.memorials.length, 1);
  // 1940 农历八月十五 → 2026 年对应公历 2026-09-25
  assert.equal(r.memorials[0].solar, "2026-09-25");
  assert.equal(r.memorials[0].lunarText, "八月十五");
  assert.equal(r.memorials[0].years, 86);
});
t("原始年份晚于总结年份的不算周年", () => {
  const r = computeYearReview({
    memorials: [{ title: "未来", calendar: "solar", date: "2030-05-20", repeat: "year" }],
    year: 2026, now: NOW,
  });
  assert.deepEqual(r.memorials, []);
});
t("一次性纪念日不进周年列表", () => {
  const r = computeYearReview({
    memorials: [{ title: "毕业", calendar: "solar", date: "2020-06-30", repeat: "none" }],
    year: 2026, now: NOW,
  });
  assert.deepEqual(r.memorials, []);
});

console.log("\n[闰年与农历年号]");
t("闰年按 366 天算日均", () => {
  const r = computeYearReview({ completions: [], year: 2024, now: NOW });
  assert.equal(Math.round(r.totals.perDay * 100000) / 100000, Math.round((0 / 366) * 100000) / 100000);
  const r2 = computeYearReview({ completions: [comp({ at: bj(2024, 3, 1) })], year: 2024, now: NOW });
  assert.equal(Math.round(r2.totals.perDay * 100000) / 100000, Math.round((1 / 366) * 100000) / 100000);
});
t("农历年号正确", () => {
  assert.equal(computeYearReview({ year: 2026, now: NOW }).lunar.text, "丙午马年");
  assert.equal(computeYearReview({ year: 2024, now: NOW }).lunar.text, "甲辰龙年");
  assert.equal(computeYearReview({ year: 2023, now: NOW }).lunar.text, "癸卯兔年");
});

console.log("\n[健壮性]");
t("脏数据不崩", () => {
  const r = computeYearReview({
    completions: [null, {}, { at: "x" }, { at: Infinity }, comp({})],
    todos: [null, {}, { deadline: "x" }],
    memorials: [null, {}, { date: "abc" }, { title: "x", date: "2020-01-01", repeat: "year" }],
    year: 2026, now: NOW,
  });
  assert.equal(r.totals.completed, 1);
  assert.equal(r.pending.total, 0);
});
t("不传 year 时用当前年份", () => {
  const r = computeYearReview({ completions: [], now: NOW });
  assert.equal(r.year, 2026);
});
t("记录数达到上限时标注 historyCapped", () => {
  const completions = [];
  for (let i = 0; i < 10; i++) completions.push(comp({ at: bj(2026, 2, 1) + i * 1000 }));
  const capped = computeYearReview({ completions, year: 2026, now: NOW, limit: 10 });
  assert.equal(capped.totals.historyCapped, true);
  const notCapped = computeYearReview({ completions, year: 2026, now: NOW, limit: 3000 });
  assert.equal(notCapped.totals.historyCapped, false);
});

console.log(`\n结果：${pass} 通过，${fail} 失败\n`);
process.exit(fail ? 1 : 0);
