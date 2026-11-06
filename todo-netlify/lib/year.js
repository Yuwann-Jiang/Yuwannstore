// 年度总结：把一年的完成记录算成一份"年度报告"
//
// 数据来源（都已在库里）：
//   completions:<用户名>  完成记录 {id, text, at, deadline, onTime}
//   todos:<用户名>        当前还没做的待办（只有这些能算"欠着"）
//   memorials:<用户名>    纪念日（用来算"今年是第几周年"）
//
// 口径约定（和统计页保持一致）：
//   · 「哪一天 / 哪一月」一律按用户本地时区算（传 tzMinutes），
//     否则北京时间早上 8 点前完成的会被算到前一天/前一月。
//   · 「一年」= 本地时区的 1 月 1 日 00:00 到 12 月 31 日 23:59。
//
// ⚠️ 完成记录上限 3000 条（见 api.js 的 MAX_COMPLETIONS）。
// 重度使用多年后最老的记录会被丢弃，所以「历史累计」是"在现存记录里"的累计，
// 返回结果里用 historyCapped 标明这一点，避免把数字说得太满。

import { dayKey, dayStartMs, weekdayOf, DEFAULT_TZ_MINUTES } from "./stats.js";
import { lunarInYear, lunar2solar, solar2lunar, ganzhiOf, zodiacOf, formatLunar } from "./lunar.js";

const DAY_MS = 86400000;

function clampTz(tz) {
  const n = Number(tz);
  if (!Number.isFinite(n)) return DEFAULT_TZ_MINUTES;
  return Math.max(-720, Math.min(840, Math.round(n)));
}

function monthOf(ms, tz) {
  return new Date(ms + tz * 60000).getUTCMonth() + 1;
}
function hourOf(ms, tz) {
  return new Date(ms + tz * 60000).getUTCHours();
}
function yearOf(ms, tz) {
  return new Date(ms + tz * 60000).getUTCFullYear();
}

// 一条完成记录是否准时
function onTimeOf(c) {
  if (c && typeof c.onTime === "boolean") return c.onTime;
  if (c && typeof c.at === "number" && typeof c.deadline === "number") return c.at <= c.deadline;
  return null;
}

function argmax(arr) {
  let idx = -1;
  let max = 0;
  arr.forEach((v, i) => {
    if (v > max) {
      max = v;
      idx = i;
    }
  });
  return idx === -1 ? null : idx;
}

function dayKeyOfMs(ms, tz) {
  return dayKey(ms, tz);
}

// 按天聚合后的最长连续天数
function longestStreakOf(dayKeys) {
  const sorted = [...new Set(dayKeys)].sort();
  let best = 0;
  let run = 0;
  let prev = null;
  for (const k of sorted) {
    if (prev) {
      const gap = Math.round((Date.parse(k + "T00:00:00Z") - Date.parse(prev + "T00:00:00Z")) / DAY_MS);
      run = gap === 1 ? run + 1 : 1;
    } else {
      run = 1;
    }
    if (run > best) best = run;
    prev = k;
  }
  return best;
}

/**
 * 计算某一年（用户本地时区）的年度总结。
 *
 * @param {object} opts
 * @param {Array}  opts.completions 完成记录
 * @param {Array}  opts.todos       当前未完成待办（用于算"还欠着"）
 * @param {Array}  opts.memorials   纪念日
 * @param {number} opts.year        要总结的年份（本地时区）
 * @param {number} opts.now         当前时间戳
 * @param {number} opts.tzMinutes   时区（比 UTC 快多少分钟）
 * @param {number} opts.limit       完成记录上限（用于标注是否被截断）
 */
export function computeYearReview({
  completions = [],
  todos = [],
  memorials = [],
  year,
  now = Date.now(),
  tzMinutes = DEFAULT_TZ_MINUTES,
  limit = 3000,
} = {}) {
  const tz = clampTz(tzMinutes);
  const targetYear = Number.isInteger(Number(year)) ? Number(year) : yearOf(now, tz);

  const comps = (Array.isArray(completions) ? completions : []).filter(
    (c) => c && typeof c.at === "number" && Number.isFinite(c.at)
  );

  const fromKey = targetYear + "-01-01";
  const toKey = targetYear + "-12-31";

  // ---------------- 这一年里的记录 ----------------
  const inYear = comps
    .filter((c) => yearOf(c.at, tz) === targetYear)
    .sort((a, b) => a.at - b.at);

  const months = Array.from({ length: 12 }, (_, i) => ({
    month: i + 1,
    count: 0,
    onTime: 0,
    late: 0,
  }));
  const weekday = [0, 0, 0, 0, 0, 0, 0];
  const hourly = new Array(24).fill(0);
  const byDay = new Map();
  let onTime = 0;
  let late = 0;
  let unknown = 0;

  for (const c of inYear) {
    const m = monthOf(c.at, tz);
    months[m - 1].count++;
    const ot = onTimeOf(c);
    if (ot === true) {
      onTime++;
      months[m - 1].onTime++;
    } else if (ot === false) {
      late++;
      months[m - 1].late++;
    } else {
      unknown++;
    }

    const k = dayKeyOfMs(c.at, tz);
    byDay.set(k, (byDay.get(k) || 0) + 1);
    weekday[weekdayOf(k)]++;
    hourly[hourOf(c.at, tz)]++;
  }

  const judged = onTime + late;
  const completed = inYear.length;

  // ---------------- 年度之最 ----------------
  let bestDay = null;
  for (const [k, n] of byDay) {
    if (!bestDay || n > bestDay.count) bestDay = { date: k, count: n };
  }
  // 月份返回 1–12（数组下标是 0–11，必须 +1，否则前端会显示错月份）
  const bestMonthIdx = argmax(months.map((x) => x.count));
  const bestMonth = bestMonthIdx === null ? null : bestMonthIdx + 1;
  const bestWeekday = argmax(weekday);
  const bestHour = argmax(hourly);

  // ---------------- 里程碑 ----------------
  // 累计序号在"现存记录"里数（受 3000 条上限影响，故额外标注）
  const allSorted = comps.slice().sort((a, b) => a.at - b.at);
  const historyTotal = allSorted.filter((c) => yearOf(c.at, tz) <= targetYear).length;
  const historyCapped = allSorted.length >= limit;

  function pickText(c) {
    return String((c && c.text) || "").slice(0, 60);
  }
  const first = inYear[0] || null;
  const last = inYear.length ? inYear[inYear.length - 1] : null;

  // 该年里有没有"累计第 100 / 500 / 1000 项"这种整千里程碑
  const milestones = [];
  const marks = [1, 50, 100, 200, 300, 500, 800, 1000, 1500, 2000, 3000];
  allSorted.forEach((c, i) => {
    const n = i + 1;
    if (marks.includes(n) && yearOf(c.at, tz) === targetYear) {
      milestones.push({ n, date: dayKeyOfMs(c.at, tz), text: pickText(c) });
    }
  });

  // ---------------- 与上一年对比 ----------------
  const prevYear = targetYear - 1;
  const prevInYear = comps.filter((c) => yearOf(c.at, tz) === prevYear);
  let compare = null;
  if (prevInYear.length) {
    let pOnTime = 0;
    let pJudged = 0;
    for (const c of prevInYear) {
      const ot = onTimeOf(c);
      if (ot === true) pOnTime++;
      if (ot !== null) pJudged++;
    }
    const prevRate = pJudged ? pOnTime / pJudged : null;
    const thisRate = judged ? onTime / judged : null;
    compare = {
      prevYear,
      prevCompleted: prevInYear.length,
      completedDelta: completed - prevInYear.length,
      prevOnTimeRate: prevRate,
      onTimeRateDelta: prevRate !== null && thisRate !== null ? thisRate - prevRate : null,
    };
  }

  // ---------------- 还欠着的（仅"今年"有意义） ----------------
  let pending = null;
  const currentYear = yearOf(now, tz);
  if (targetYear === currentYear) {
    const list = (Array.isArray(todos) ? todos : []).filter(
      (t) => t && Number.isFinite(t.deadline)
    );
    const overdue = list.filter((t) => t.deadline < now);
    const oldest = overdue.length
      ? Math.max(...overdue.map((t) => Math.round((now - t.deadline) / DAY_MS)))
      : 0;
    pending = {
      total: list.length,
      overdue: overdue.length,
      oldestOverdueDays: oldest,
    };
  }

  // ---------------- 今年的农历年号（干支 / 生肖） ----------------
  // 取年中（6 月 1 日）对应的农历年，避开春节前后跨年的边界
  let lunarYearNumber = null;
  try {
    const mid = solar2lunar(targetYear, 6, 1);
    lunarYearNumber = mid ? mid.year : null;
  } catch {
    lunarYearNumber = null;
  }

  // ---------------- 今年过周年的纪念日 ----------------
  const memHighlights = [];
  for (const m of Array.isArray(memorials) ? memorials : []) {
    if (!m || typeof m.date !== "string") continue;
    if (m.repeat === "none") continue; // 一次性的不算"周年"
    const parts = m.date.split("-").map(Number);
    if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) continue;
    const [baseYear, baseMonth, baseDay] = parts;

    let solarKey = null;
    let lunarText = "";
    let anniversaryYear = targetYear;

    if (m.calendar === "lunar") {
      const ly = lunarYearNumber !== null ? lunarYearNumber : targetYear;
      const conv = lunarInYear(ly, baseMonth, baseDay, m.isLeap === true);
      if (!conv) continue;
      solarKey = conv.year + "-" + String(conv.month).padStart(2, "0") + "-" + String(conv.day).padStart(2, "0");
      lunarText = formatLunar({ month: baseMonth, day: baseDay, isLeap: m.isLeap === true });
      anniversaryYear = ly;
    } else {
      solarKey = targetYear + "-" + String(baseMonth).padStart(2, "0") + "-" + String(baseDay).padStart(2, "0");
    }

    // 只保留确实落在这一年的（农历换算偶尔会跨到邻年）
    if (!solarKey.startsWith(String(targetYear) + "-")) continue;
    if (solarKey < fromKey || solarKey > toKey) continue;

    const years = anniversaryYear - baseYear;
    if (years <= 0) continue;

    memHighlights.push({
      title: m.title,
      solar: solarKey,
      lunarText,
      years,
      calendar: m.calendar === "lunar" ? "lunar" : "solar",
    });
  }
  memHighlights.sort((a, b) => (a.solar < b.solar ? -1 : 1));

  return {
    year: targetYear,
    tzMinutes: tz,
    range: { from: fromKey, to: toKey },
    lunar: lunarYearNumber
      ? {
          year: lunarYearNumber,
          ganzhi: ganzhiOf(lunarYearNumber),
          zodiac: zodiacOf(lunarYearNumber),
          text: ganzhiOf(lunarYearNumber) + zodiacOf(lunarYearNumber) + "年",
        }
      : null,
    totals: {
      completed,
      onTime,
      late,
      unknown,
      onTimeRate: judged ? onTime / judged : null,
      activeDays: byDay.size,
      perActiveDay: byDay.size ? completed / byDay.size : 0,
      perDay: completed / (isLeapYear(targetYear) ? 366 : 365),
      longestStreak: longestStreakOf([...byDay.keys()]),
      historyTotal,
      historyCapped,
    },
    months,
    best: {
      day: bestDay,
      month: bestMonth,
      weekday: bestWeekday,
      hour: bestHour,
    },
    first: first ? { date: dayKeyOfMs(first.at, tz), text: pickText(first) } : null,
    last: last ? { date: dayKeyOfMs(last.at, tz), text: pickText(last) } : null,
    milestones,
    compare,
    pending,
    memorials: memHighlights.slice(0, 12),
    weekday,
    hourly,
  };
}

function isLeapYear(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}
