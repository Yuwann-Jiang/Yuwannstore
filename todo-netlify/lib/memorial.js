// 「纪念」模块：校验与规范化
//
// 为什么日期用 "YYYY-MM-DD" 字符串，而不是毫秒时间戳：
//   纪念日（生日、在一起第几天、逝世纪念…）是**日历上的一天**，不是某个瞬间。
//   如果用时间戳，同一个日期在不同时区会算出相差一天：
//   北京时间 2023-05-20 00:00 存成时间戳，在 UTC 里就变成 2023-05-19 16:00，
//   再过一次"取日期"就变成 5 月 19 日，纪念日会硬生生错一天。
//   存日历日期字符串则永远不漂移，倒计时由前端按用户本地时区计算。
//
// 每条纪念日的结构：
//   {
//     id:       12 位随机串
//     title:    纪念什么，≤ 50 字
//     calendar: "solar" = 公历（默认）｜"lunar" = 农历
//     date:     "YYYY-MM-DD"
//               · calendar=solar 时是公历日期
//               · calendar=lunar 时是农历日期（年-月-日，日是初一…三十）
//     isLeap:   仅农历有意义：那一天是否落在闰月
//     repeat:   "year" = 每年重复（生日/纪念日）｜"none" = 只此一次
//     note:     备注，可选，≤ 200 字
//     created:  创建时间戳
//     updatedAt: 有编辑过才有
//   }
//
// 为什么农历也存 "YYYY-MM-DD"：农历日期同样是"日历上的一天"，
// 用字符串存既能人读又能直接校验；换算成公历由 lib/lunar.js 负责。

import { lunar2solar, MIN_YEAR as LUNAR_MIN_YEAR, MAX_YEAR as LUNAR_MAX_YEAR } from "./lunar.js";

export const MAX_MEMORIALS = 500;
export const CALENDAR_VALUES = ["solar", "lunar"];
export const MAX_TITLE_LEN = 50;
export const MAX_NOTE_LEN = 200;
export const REPEAT_VALUES = ["year", "none"];

// 合法的日历日期（含闰年判断）
export function normalizeDate(input) {
  const s = String(input ?? "").trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;

  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1900 || y > 2200) return null;
  if (mo < 1 || mo > 12) return null;
  if (d < 1 || d > 31) return null;

  // 用 UTC 构造再回读，能自动排除 2 月 30 日、平年 2 月 29 日这类不存在的日期
  // （用本地时区构造在某些时区的夏令时切换日会被"修正"成前一天，UTC 不会有这个坑）
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== mo - 1 ||
    dt.getUTCDate() !== d
  ) {
    return null;
  }
  return s;
}

export function normalizeTitle(input) {
  const s = String(input ?? "").trim();
  if (!s) return null;
  return s.slice(0, MAX_TITLE_LEN);
}

export function normalizeNote(input) {
  const s = String(input ?? "").trim();
  return s ? s.slice(0, MAX_NOTE_LEN) : "";
}

// 农历日期：必须是真实存在的农历日（含闰月是否存在、该月是否有三十）
export function normalizeLunarDate(input, isLeap = false) {
  const s = String(input ?? "").trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;

  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < LUNAR_MIN_YEAR || y > LUNAR_MAX_YEAR) return null;
  if (mo < 1 || mo > 12) return null;
  if (d < 1 || d > 30) return null;

  // lunar2solar 会顺手验证：该年是否有这个闰月、该月有没有三十
  const solar = lunar2solar(y, mo, d, isLeap);
  if (!solar) return null;
  return { text: s, solar };
}

export function normalizeCalendar(input) {
  const s = String(input ?? "").trim().toLowerCase();
  if (!s) return "solar";
  return CALENDAR_VALUES.includes(s) ? s : null;
}

export function normalizeRepeat(input) {
  const s = String(input ?? "").trim().toLowerCase();
  // 默认「每年重复」：纪念日绝大多数是周年性的，
  // 默认值选错会让用户第一步就困惑
  if (!s) return "year";
  return REPEAT_VALUES.includes(s) ? s : null;
}

/**
 * 校验一条纪念日的输入。
 * 编辑时传 partial=true，只校验传了的字段。
 *
 * @returns {{ok: true, value: object} | {ok: false, error: string}}
 */
export function validateMemorial(body, { partial = false } = {}) {
  if (!body || typeof body !== "object") return { ok: false, error: "请求格式有误" };

  const out = {};

  if (!partial || body.title !== undefined) {
    const title = normalizeTitle(body.title);
    if (title === null) return { ok: false, error: "纪念的名称不能为空" };
    out.title = title;
  }

  // 日历类型：默认公历
  let calendar = body.calendar === undefined ? (partial ? undefined : "solar") : normalizeCalendar(body.calendar);
  if (calendar === null) return { ok: false, error: "日历类型只能是 solar 或 lunar" };
  if (calendar !== undefined) out.calendar = calendar;

  // 是否闰月（只有农历有意义）
  let isLeap = false;
  if (body.isLeap !== undefined) {
    if (typeof body.isLeap !== "boolean") return { ok: false, error: "isLeap 必须是布尔值" };
    isLeap = body.isLeap;
  }

  if (!partial || body.date !== undefined) {
    if (calendar === "lunar") {
      const lunar = normalizeLunarDate(body.date, isLeap);
      if (lunar === null) {
        return {
          ok: false,
          error: isLeap
            ? "这不是一个存在的农历日期（该年可能没有这个闰月，或这个月没有三十）"
            : "这不是一个存在的农历日期（请检查月份与初一～三十）",
        };
      }
      out.date = lunar.text;
    } else {
      const date = normalizeDate(body.date);
      if (date === null) return { ok: false, error: "日期格式应为 2023-05-20 这样的真实日期" };
      out.date = date;
    }
  }

  // 公历没有闰月概念，存下来会让人误解，直接归零
  const effectiveCalendar = out.calendar || (partial ? undefined : "solar");
  if (effectiveCalendar === "lunar") {
    if (body.isLeap !== undefined) out.isLeap = isLeap;
    else if (!partial) out.isLeap = false;
  } else if (body.isLeap !== undefined || !partial) {
    out.isLeap = false;
  }

  if (body.repeat !== undefined) {
    const repeat = normalizeRepeat(body.repeat);
    if (repeat === null) return { ok: false, error: "重复方式只能是 year 或 none" };
    out.repeat = repeat;
  } else if (!partial) {
    out.repeat = "year";
  }

  if (body.note !== undefined) {
    out.note = normalizeNote(body.note);
  } else if (!partial) {
    out.note = "";
  }

  if (partial && Object.keys(out).length === 0) {
    return { ok: false, error: "没有要修改的内容" };
  }

  return { ok: true, value: out };
}
