// 统计计算：把「待办 + 完成历史」算成统计页需要的一组数字
//
// 设计要点（踩过的坑）：
//   1. 时区。服务器（Netlify Functions）跑在 UTC，而用户在中国（UTC+8）。
//      如果按 UTC 切分"哪一天"，每天早上 8 点之前完成的待办会被算到前一天，
//      统计页就会和热力图（前端按本地时间算）对不上。
//      所以这里统一接收一个 tzMinutes（"比 UTC 快多少分钟"，北京 = 480），
//      所有"天"的边界都按这个偏移计算。注意方向：JS 的
//      getTimezoneOffset() 返回的是相反数（北京返回 -480），前端传的是 -offset。
//   2. 完成记录最多保留 3000 条（见 api.js 的 MAX_COMPLETIONS），
//      所以"最长连续天数"理论上可能被截断，这个限制在 README 里有说明。
//   3. 待办被"撤销完成"时对应记录会被回滚，所以这里不需要额外过滤。

const DAY_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_TZ_MINUTES = 480; // 北京时间（UTC+8）

function clampTz(tz) {
  const n = Number(tz);
  if (!Number.isFinite(n)) return DEFAULT_TZ_MINUTES;
  return Math.max(-720, Math.min(840, Math.round(n))); // 现实中的时区范围
}

// 时间戳 → 用户本地日期字符串 YYYY-MM-DD
export function dayKey(ms, tzMinutes = DEFAULT_TZ_MINUTES) {
  const tz = clampTz(tzMinutes);
  return new Date(ms + tz * 60000).toISOString().slice(0, 10);
}

// 日期字符串 → 该本地日 00:00 对应的时间戳
export function dayStartMs(key, tzMinutes = DEFAULT_TZ_MINUTES) {
  const tz = clampTz(tzMinutes);
  return Date.parse(key + "T00:00:00Z") - tz * 60000;
}

// 日期字符串 → 星期几（0=周日 … 6=周六）
export function weekdayOf(key) {
  return new Date(key + "T00:00:00Z").getUTCDay();
}

// 日期字符串 → 该周周一
export function weekStartOf(key) {
  const d = new Date(key + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

// 日期字符串之间相差的天数（b - a）
function diffDays(a, b) {
  return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / DAY_MS);
}

function shiftKey(key, deltaDays) {
  return new Date(Date.parse(key + "T00:00:00Z") + deltaDays * DAY_MS).toISOString().slice(0, 10);
}

// 一条完成记录是否按时完成。返回 true / false / null（老记录缺字段，无法判断）
function onTimeOf(c) {
  if (c && typeof c.onTime === "boolean") return c.onTime;
  if (c && typeof c.at === "number" && typeof c.deadline === "number") return c.at <= c.deadline;
  return null;
}

function median(arr) {
  if (!arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

/**
 * 计算统计页所需的全部数字。
 *
 * @param {object}   opts
 * @param {Array}    opts.todos        当前未完成的待办
 * @param {Array}    opts.completions  完成历史（{id,text,at,deadline,onTime}）
 * @param {number}   opts.now          当前时间戳（便于测试）
 * @param {number}   opts.days         统计窗口天数（1-365，默认 90）
 * @param {number}   opts.tzMinutes    客户端时区（比 UTC 快多少分钟）
 */
export function computeStats({
  todos = [],
  completions = [],
  now = Date.now(),
  days = 90,
  tzMinutes = DEFAULT_TZ_MINUTES,
} = {}) {
  const tz = clampTz(tzMinutes);
  const rawDays = Number(days);
  const span = Number.isFinite(rawDays)
    ? Math.max(1, Math.min(365, Math.round(rawDays)))
    : 90;

  const safeTodos = (Array.isArray(todos) ? todos : []).filter(
    (t) => t && Number.isFinite(t.deadline)
  );
  const safeComps = (Array.isArray(completions) ? completions : []).filter(
    (c) => c && typeof c.at === "number" && Number.isFinite(c.at)
  );

  const todayKey = dayKey(now, tz);
  const fromKey = shiftKey(todayKey, -(span - 1));

  // ---------------- 按天聚合（全量，不受窗口限制，用于连续天数/最佳日） ----------------
  const allByDay = new Map(); // key -> {count, onTime, late}
  for (const c of safeComps) {
    const k = dayKey(c.at, tz);
    let b = allByDay.get(k);
    if (!b) allByDay.set(k, (b = { count: 0, onTime: 0, late: 0 }));
    b.count++;
    const ot = onTimeOf(c);
    if (ot === true) b.onTime++;
    else if (ot === false) b.late++;
  }

  // ---------------- 窗口内的每日序列（前端画柱状图） ----------------
  const daily = [];
  for (let i = 0; i < span; i++) {
    const k = shiftKey(fromKey, i);
    const b = allByDay.get(k);
    daily.push({
      date: k,
      count: b ? b.count : 0,
      onTime: b ? b.onTime : 0,
      late: b ? b.late : 0,
    });
  }

  // ---------------- 窗口内的按周序列（近 12 周 + 本周） ----------------
  const weeklyMap = new Map();
  for (const d of daily) {
    const wk = weekStartOf(d.date);
    if (!weeklyMap.has(wk)) weeklyMap.set(wk, 0);
    weeklyMap.set(wk, weeklyMap.get(wk) + d.count);
  }
  const weekly = [...weeklyMap.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([weekStart, count]) => ({ weekStart, count }));

  // ---------------- 完成情况 ----------------
  let onTime = 0;
  let late = 0;
  let unknown = 0;
  const weekday = [0, 0, 0, 0, 0, 0, 0];
  const hourly = new Array(24).fill(0);
  let inRange = 0;

  for (const c of safeComps) {
    const ot = onTimeOf(c);
    if (ot === true) onTime++;
    else if (ot === false) late++;
    else unknown++;
  }

  for (const c of safeComps) {
    const k = dayKey(c.at, tz);
    if (k < fromKey || k > todayKey) continue;
    inRange++;
    weekday[weekdayOf(k)]++;
    hourly[new Date(c.at + tz * 60000).getUTCHours()]++;
  }

  const judged = onTime + late;

  // ---------------- 当前待办的时间分布 ----------------
  const active = { total: safeTodos.length, overdue: 0, within1d: 0, within3d: 0, within7d: 0, later: 0 };
  for (const t of safeTodos) {
    const remain = t.deadline - now;
    if (remain < 0) active.overdue++;
    else if (remain <= DAY_MS) active.within1d++;
    else if (remain <= 3 * DAY_MS) active.within3d++;
    else if (remain <= 7 * DAY_MS) active.within7d++;
    else active.later++;
  }

  // ---------------- 连续完成天数 ----------------
  let current = 0;
  let cursor = todayKey;
  // 今天还没完成就从昨天开始算，避免"今天还没做"就把记录清零
  if (!allByDay.has(cursor)) cursor = shiftKey(cursor, -1);
  while (allByDay.has(cursor)) {
    current++;
    cursor = shiftKey(cursor, -1);
  }

  let longest = 0;
  let run = 0;
  let prev = null;
  for (const k of [...allByDay.keys()].sort()) {
    run = prev && diffDays(prev, k) === 1 ? run + 1 : 1;
    if (run > longest) longest = run;
    prev = k;
  }

  // ---------------- 极值 ----------------
  let bestDay = null;
  let activeDays = 0;
  for (const d of daily) {
    if (d.count > 0) activeDays++;
    if (!bestDay || d.count > bestDay.count) bestDay = d;
  }
  if (bestDay && bestDay.count === 0) bestDay = null;

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

  // ---------------- 计划提前量（未完成待办：创建 → 截止） ----------------
  const leads = safeTodos
    .filter((t) => Number.isFinite(t.created) && t.deadline > t.created)
    .map((t) => t.deadline - t.created);

  return {
    generatedAt: now,
    tzMinutes: tz,
    days: span,
    range: { from: fromKey, to: todayKey },
    active,
    done: {
      total: safeComps.length,
      onTime,
      late,
      unknown,
      inRange,
      onTimeRate: judged ? onTime / judged : null,
      lateRate: judged ? late / judged : null,
    },
    streak: { current, longest, activeDays, bestDay },
    daily,
    weekly,
    weekday,
    hourly,
    average: {
      perDayInRange: inRange / span,
      perActiveDay: activeDays ? inRange / activeDays : 0,
      busiestWeekday: argmax(weekday),
      busiestHour: argmax(hourly),
    },
    lead: {
      count: leads.length,
      averageMs: leads.length ? Math.round(leads.reduce((a, b) => a + b, 0) / leads.length) : null,
      medianMs: median(leads),
    },
  };
}
