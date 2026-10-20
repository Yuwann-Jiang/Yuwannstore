// 日历导出（iCalendar / RFC 5545）
//
// 为什么是 VEVENT 而不是 VTODO：
//   VTODO 是"待办"的标准表示，但 Google 日历对 VTODO 支持很差（导入后经常
//   什么都不显示），而 VEVENT 在所有日历（Google / Apple / Outlook / 手机自带）
//   都能正确导入并显示。所以这里把每条待办导出成"一个 30 分钟的日程，
//   结束时间 = 截止时间"，并带一个提前 1 天的提醒（VALARM）。
//
// 时间一律用 UTC（…Z 结尾）。这样导入方会自动换算成当地时区显示，
// 也不需要附带 VTIMEZONE 定义（手写时区规则很容易出错）。

import { lunar2solar, lunarInYear, solar2lunar, formatLunar, ganzhiOf } from "./lunar.js";

const MIN_MS = 60 * 1000;
const EVENT_LENGTH_MS = 30 * MIN_MS; // 每条待办在日历里占 30 分钟

// iCalendar 文本转义：反斜杠、分号、逗号、换行
export function escapeIcsText(s) {
  return String(s ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

// 折行：RFC 5545 要求每行不超过 75 个**字节**（不是字符），
// 续行以一个空格开头。中文一个字 3 字节，所以一条 30 字的中文待办
// 必然超过 75 字节 —— 不折行的话部分日历会解析失败。
export function foldLine(line, limit = 75) {
  if (Buffer.byteLength(line, "utf8") <= limit) return line;

  const out = [];
  let cur = "";
  let curLen = 0;
  // 按"码点"遍历，避免把中文或 emoji 从中间劈开
  for (const ch of line) {
    const b = Buffer.byteLength(ch, "utf8");
    if (curLen + b > limit) {
      out.push(cur);
      cur = " " + ch; // 续行：空格 + 内容，空格本身也计入 75 字节
      curLen = 1 + b;
    } else {
      cur += ch;
      curLen += b;
    }
  }
  if (cur) out.push(cur);
  return out.join("\r\n");
}

// 时间戳 → iCalendar 的 UTC 时间格式 20261020T120000Z
export function icsUtc(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return (
    d.getUTCFullYear() +
    p(d.getUTCMonth() + 1) +
    p(d.getUTCDate()) +
    "T" +
    p(d.getUTCHours()) +
    p(d.getUTCMinutes()) +
    p(d.getUTCSeconds()) +
    "Z"
  );
}

// 时间戳 → 便于人读的本地时间（放在 DESCRIPTION 里）
export function fmtLocal(ms, tzMinutes) {
  const d = new Date(ms + tzMinutes * MIN_MS);
  const p = (n) => String(n).padStart(2, "0");
  return (
    d.getUTCFullYear() +
    "-" +
    p(d.getUTCMonth() + 1) +
    "-" +
    p(d.getUTCDate()) +
    " " +
    p(d.getUTCHours()) +
    ":" +
    p(d.getUTCMinutes())
  );
}

/**
 * 生成 .ics 文本。
 *
 * @param {object} opts
 * @param {Array}  opts.todos       待办数组
 * @param {string} opts.appUrl      应用地址（写进 DESCRIPTION）
 * @param {number} opts.now         生成时间
 * @param {boolean} opts.alarms     是否带"提前 1 天"提醒
 * @param {number} opts.tzMinutes   本地时区偏移（只影响文字说明里的时间）
 * @param {string} opts.calName     日历名称
 * @param {string} opts.uidHost     UID 后缀，避免和其他日历撞车
 */
export function buildCalendar({
  todos = [],
  appUrl = "",
  now = Date.now(),
  alarms = true,
  tzMinutes = 480,
  calName = "我的待办",
  uidHost = "yuwann-todo",
} = {}) {
  const stamp = icsUtc(now);
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Yuwann Todo//Todo Due Calendar//CN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:" + escapeIcsText(calName),
    "X-WR-TIMEZONE:Asia/Shanghai",
  ];

  const valid = (Array.isArray(todos) ? todos : []).filter(
    (t) => t && Number.isFinite(t.deadline) && typeof t.text === "string"
  );

  for (const t of valid) {
    const start = t.deadline - EVENT_LENGTH_MS;
    const end = t.deadline;
    const uid = String(t.id || "todo").replace(/[^A-Za-z0-9_-]/g, "") + "@" + uidHost;

    const desc = [
      "截止时间：" + fmtLocal(t.deadline, tzMinutes),
      appUrl ? "打开待办清单：" + appUrl : "",
    ]
      .filter(Boolean)
      .join("\n");

    lines.push(
      "BEGIN:VEVENT",
      "UID:" + uid,
      "DTSTAMP:" + stamp,
      "DTSTART:" + icsUtc(start),
      "DTEND:" + icsUtc(end),
      "SUMMARY:" + escapeIcsText(t.text),
      "DESCRIPTION:" + escapeIcsText(desc),
      "TRANSP:OPAQUE",
      "STATUS:CONFIRMED",
      "CATEGORIES:待办"
    );

    if (alarms) {
      lines.push(
        "BEGIN:VALARM",
        "ACTION:DISPLAY",
        "DESCRIPTION:" + escapeIcsText("待办还有不到 1 天到期：" + t.text),
        "TRIGGER:-P1D",
        "END:VALARM"
      );
    }

    lines.push("END:VEVENT");
  }

  lines.push("END:VCALENDAR");

  // 折行后用 CRLF 连接（RFC 5545 要求行分隔符是 CRLF）
  return lines.map((l) => foldLine(l)).join("\r\n") + "\r\n";
}

// ---------------------------------------------------------------------------
// 纪念日导出
//
// 与待办导出的关键差别：纪念日是**全天事件**（DTSTART;VALUE=DATE），
// 而且大多每年重复。两种重复的处理方式不同：
//
//   公历 + 每年重复   → 用 RRULE:FREQ=YEARLY，一条事件永久重复（最省）
//   农历 + 每年重复   → **必须逐次展开**！农历日期换算到公历每年都在漂
//                       （比如农历八月十五可能落在 9/15 也可能 10/3），
//                       用 RRULE 每年来重复同一个公历日子是错的。
//                       这里展开未来 30 年，每条一个事件。
// ---------------------------------------------------------------------------

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

function dateKeyToIcsDate(key) {
  return String(key || "").replace(/-/g, "");
}

function addDaysKey(key, delta) {
  const d = new Date(Date.parse(key + "T00:00:00Z") + delta * 86400000);
  return d.toISOString().slice(0, 10);
}

export function buildMemorialCalendar({
  memorials = [],
  now = Date.now(),
  alarms = true,
  calName = "我的纪念日",
  uidHost = "yuwann-todo",
  years = 30,
  appUrl = "",
} = {}) {
  const stamp = icsUtc(now);
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Yuwann Todo//Memorial Calendar//CN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:" + escapeIcsText(calName),
    "X-WR-TIMEZONE:Asia/Shanghai",
  ];

  const todayKey = new Date(now).toISOString().slice(0, 10);
  const todayLunar = solar2lunar(
    Number(todayKey.slice(0, 4)),
    Number(todayKey.slice(5, 7)),
    Number(todayKey.slice(8, 10))
  );
  const centerLunarYear = todayLunar ? todayLunar.year : Number(todayKey.slice(0, 4));

  const list = (Array.isArray(memorials) ? memorials : []).filter(
    (m) => m && typeof m.title === "string" && /^\d{4}-\d{2}-\d{2}$/.test(String(m.date || ""))
  );

  function pushEvent({ uid, startKey, summary, description, rrule, anniversary }) {
    lines.push(
      "BEGIN:VEVENT",
      "UID:" + uid,
      "DTSTAMP:" + stamp,
      "DTSTART;VALUE=DATE:" + dateKeyToIcsDate(startKey),
      "DTEND;VALUE=DATE:" + dateKeyToIcsDate(addDaysKey(startKey, 1)),
      "SUMMARY:" + escapeIcsText(summary),
      "DESCRIPTION:" + escapeIcsText(description),
      "TRANSP:TRANSPARENT",
      "STATUS:CONFIRMED",
      "CATEGORIES:" + escapeIcsText(anniversary ? "纪念日" : "纪念")
    );
    if (rrule) lines.push("RRULE:" + rrule);
    if (alarms) {
      lines.push(
        "BEGIN:VALARM",
        "ACTION:DISPLAY",
        // 全天事件从 00:00 开始，-PT15H = 前一天早上 9 点提醒
        "DESCRIPTION:" + escapeIcsText("明天是" + summary),
        "TRIGGER:-PT15H",
        "END:VALARM"
      );
    }
    lines.push("END:VEVENT");
  }

  for (const m of list) {
    const id = String(m.id || m.date).replace(/[^A-Za-z0-9_-]/g, "");
    const note = m.note ? "\n备注：" + m.note : "";
    const isLunar = m.calendar === "lunar";
    const repeat = m.repeat === "none" ? "none" : "year";

    if (!isLunar) {
      const base = m.date;
      if (repeat === "none") {
        pushEvent({
          uid: id + "-once@" + uidHost,
          startKey: base,
          summary: m.title,
          description: "公历 " + base + note,
        });
        continue;
      }
      // 每年重复：以"下一次"为起点，避免日历里出现几十条历史事件
      let startKey = base;
      if (startKey < todayKey) {
        const md = base.slice(5);
        startKey = todayKey.slice(0, 4) + "-" + md;
        if (startKey < todayKey) startKey = String(Number(todayKey.slice(0, 4)) + 1) + "-" + md;
      }
      const yearGap = Number(startKey.slice(0, 4)) - Number(base.slice(0, 4));
      pushEvent({
        uid: id + "@" + uidHost,
        startKey,
        summary: m.title,
        description:
          "公历 " + base + " · 每年重复" +
          (yearGap > 0 ? "\n第 " + yearGap + " 周年起" : "") +
          note,
        rrule: "FREQ=YEARLY",
        anniversary: true,
      });
      continue;
    }

    // ---------------- 农历 ----------------
    const [ly, lm, ld] = String(m.date).split("-").map(Number);
    const wantLeap = m.isLeap === true;
    const label = "农历 " + formatLunar({ month: lm, day: ld, isLeap: wantLeap }) +
      "（" + ganzhiOf(ly) + "年）";

    if (repeat === "none") {
      const s = lunar2solar(ly, lm, ld, wantLeap);
      if (!s) continue;
      const key = s.year + "-" + String(s.month).padStart(2, "0") + "-" + String(s.day).padStart(2, "0");
      pushEvent({
        uid: id + "-once@" + uidHost,
        startKey: key,
        summary: m.title,
        description: label + " → 公历 " + key + note,
      });
      continue;
    }

    // 每年重复的农历：逐次展开未来 years 年
    let emitted = 0;
    for (let i = -1; i < years && emitted < years; i++) {
      const lunarYear = centerLunarYear + i;
      const s = lunarInYear(lunarYear, lm, ld, wantLeap);
      if (!s) continue;
      const key = s.year + "-" + String(s.month).padStart(2, "0") + "-" + String(s.day).padStart(2, "0");
      if (key < todayKey) continue; // 已经过去的这次不用导
      const k = lunarYear - ly;
      pushEvent({
        uid: id + "-" + lunarYear + "@" + uidHost,
        startKey: key,
        summary: m.title,
        description:
          label + " → 公历 " + key +
          (k > 0 ? "\n第 " + k + " 周年" : "") +
          note,
        anniversary: true,
      });
      emitted++;
    }
  }

  lines.push("END:VCALENDAR");
  return lines.map((l) => foldLine(l)).join("\r\n") + "\r\n";
}
