// 前端逻辑自测：不开浏览器，用最小 DOM 替身跑 public/index.html 里的内联脚本
//
// 覆盖：统计页渲染、柱状图渲染、撤销提示、颜色分档、剩余时间格式化。
// 只验证"算得对、拼得出 HTML"，不验证视觉排版（那要靠真机/真浏览器看）。
//
// 运行：node test-ui-logic.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
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

// ---------------------------------------------------------------------------
// 最小 DOM 替身：getElementById 按需创建，innerHTML 存起来方便断言
// ---------------------------------------------------------------------------
function makeClassList() {
  const set = new Set();
  return {
    _set: set,
    add: (...c) => c.forEach((x) => set.add(x)),
    remove: (...c) => c.forEach((x) => set.delete(x)),
    contains: (c) => set.has(c),
    toggle: (c, force) => {
      const on = force === undefined ? !set.has(c) : !!force;
      if (on) set.add(c); else set.delete(c);
      return on;
    },
  };
}

function makeEl(id = "") {
  const el = {
    id,
    tagName: "DIV",
    dataset: {},
    style: {},
    children: [],
    _html: "",
    textContent: "",
    value: "",
    disabled: false,
    title: "",
    classList: makeClassList(),
    addEventListener() {},
    removeEventListener() {},
    appendChild(c) { this.children.push(c); return c; },
    remove() {},
    setAttribute(k, v) { this[k] = v; },
    getAttribute() { return null; },
    focus() {},
    select() {},
    scrollIntoView() {},
    click() {},
    closest() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  Object.defineProperty(el, "innerHTML", {
    get() { return this._html; },
    set(v) { this._html = v; },
  });
  return el;
}

const els = new Map();
const document = {
  getElementById(id) {
    if (!els.has(id)) els.set(id, makeEl(id));
    return els.get(id);
  },
  createElement(tag) {
    const el = makeEl();
    el.tagName = String(tag).toUpperCase();
    return el;
  },
  body: makeEl("body"),
  querySelector() { return null; },
  querySelectorAll() { return []; },
  addEventListener() {},
};

const storage = new Map();
const localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k),
};

const sandbox = {
  document,
  localStorage,
  navigator: { onLine: true, userAgent: "node-test", language: "zh-CN" },
  location: { hostname: "localhost", href: "http://localhost/", search: "" },
  console,
  setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {},
  alert() {},
  fetch: async () => ({ ok: false, status: 401, json: async () => ({}), text: async () => "" }),
  Blob: class Blob { constructor(parts) { this.parts = parts; } },
  URL: Object.assign(function URL() {}, { createObjectURL: () => "blob:test", revokeObjectURL() {} }),
  Request: class Request {},
  Response: class Response {},
  Math, JSON, Date, Number, String, Boolean, Object, Array, Set, Map, isNaN, parseInt, parseFloat,
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.window.matchMedia = () => ({ matches: false });
sandbox.window.addEventListener = () => {};

// ---------------------------------------------------------------------------
// 取出内联脚本并执行
// ---------------------------------------------------------------------------
const html = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
const m = html.match(/<script>([\s\S]*?)<\/script>/);
assert.ok(m, "没找到内联脚本");

const source =
  m[1] +
  "\n;globalThis.__t = { renderStats, renderCols, showToast, hideToast, showUndo," +
  " fmtPct, fmtDuration, classify, levelOf, calcStreak, dateKey, fmtRemain, shorten, escapeHtml," +
  " memorialInfo, sortMemorials, renderMemorials, renderMemBanner, emojiOf, parseDateKey," +
  " daysBetween, fmtDateKey, readMemDate, setMemCalendar, buildLunarSelectors," +
  " LUNAR_MONTH_NAMES, LUNAR_DAY_NAMES," +
  " setMemorials: function (l) { memorials = l; }, getMemorials: function () { return memorials; } };\n";

vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: "index.html:inline" });
const T = sandbox.__t;

// ---------------------------------------------------------------------------
console.log("\n[颜色分档]");
t("≤24 小时是红色", () => {
  const now = Date.now();
  assert.equal(T.classify(now + 1000).level, "red");
  assert.equal(T.classify(now - 1000).level, "red"); // 已超时也是红
});
t(">24h 且 ≤4 天是黄色", () => {
  const DAY = 86400000;
  assert.equal(T.classify(Date.now() + 1.5 * DAY).level, "yellow");
  assert.equal(T.classify(Date.now() + 3.99 * DAY).level, "yellow");
});
t(">4 天是绿色", () => {
  assert.equal(T.classify(Date.now() + 5 * 86400000).level, "green");
});

console.log("\n[剩余时间文案]");
t("超时显示「已超时」前缀", () => {
  assert.ok(T.fmtRemain(-3600000).startsWith("已超时 "));
});
t("小于 1 小时显示分钟", () => {
  assert.match(T.fmtRemain(30 * 60000), /^\d+分$/);
});

console.log("\n[热力图等级]");
t("完成数映射到 0-4 级", () => {
  assert.deepEqual([0, 1, 2, 3, 5, 9].map(T.levelOf), [0, 1, 2, 2, 3, 4]);
});
t("连续天数按天去重计算", () => {
  const byDay = new Map();
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  byDay.set(T.dateKey(d), []);
  const y = new Date(d); y.setDate(y.getDate() - 1);
  byDay.set(T.dateKey(y), []);
  assert.equal(T.calcStreak(byDay), 2);
});

console.log("\n[浮层提示 / 撤销]");
t("showToast 显示文本并设置按钮文案", () => {
  T.showToast("测试提示", { actionLabel: "撤销", onAction: () => {}, ms: 1000 });
  assert.equal(document.getElementById("toastText").textContent, "测试提示");
  assert.equal(document.getElementById("toastAction").textContent, "撤销");
  assert.equal(document.getElementById("toast").classList.contains("hidden"), false);
  T.hideToast();
});
t("hideToast 隐藏提示条", () => {
  assert.equal(document.getElementById("toast").classList.contains("hidden"), true);
});
t("长标题会被截断", () => {
  assert.equal(T.shorten("一二三四五六七八九十", 5), "一二三四五…");
  assert.equal(T.shorten("短", 5), "短");
});
t("完成待办后提示里带待办名称", () => {
  T.showUndo({ id: "abc", text: "写周报" }, "cmp1");
  assert.equal(document.getElementById("toastText").textContent, "已完成「写周报」");
  assert.equal(document.getElementById("toastAction").textContent, "撤销");
  T.hideToast();
});

console.log("\n[统计页渲染]");
const sample = {
  generatedAt: Date.now(),
  tzMinutes: 480,
  days: 30,
  range: { from: "2026-09-21", to: "2026-10-20" },
  active: { total: 5, overdue: 1, within1d: 1, within3d: 1, within7d: 1, later: 1 },
  done: { total: 12, onTime: 9, late: 3, unknown: 0, inRange: 8, onTimeRate: 0.75, lateRate: 0.25 },
  streak: { current: 3, longest: 6, activeDays: 5, bestDay: { date: "2026-10-18", count: 4 } },
  daily: Array.from({ length: 30 }, (_, i) => ({
    date: "2026-09-" + String(21 + i).padStart(2, "0"),
    count: i % 4,
    onTime: i % 4,
    late: 0,
  })),
  weekly: [
    { weekStart: "2026-10-12", count: 3 },
    { weekStart: "2026-10-19", count: 5 },
  ],
  weekday: [1, 0, 2, 0, 3, 1, 1],
  hourly: Array.from({ length: 24 }, (_, i) => (i === 21 ? 4 : 0)),
  average: { perDayInRange: 0.27, perActiveDay: 1.6, busiestWeekday: 4, busiestHour: 21 },
  lead: { count: 3, averageMs: 2 * 86400000, medianMs: 86400000 },
};

t("副标题显示日期范围与天数", () => {
  T.renderStats(sample);
  const sub = document.getElementById("statsSub").textContent;
  assert.ok(sub.includes("2026-09-21"), sub);
  assert.ok(sub.includes("30 天"), sub);
});

t("指标卡显示准时率与连续天数", () => {
  T.renderStats(sample);
  const cards = document.getElementById("statCards").innerHTML;
  assert.ok(cards.includes("75%"), "缺少准时率");
  assert.ok(cards.includes("3 天"), "缺少当前连续");
  assert.ok(cards.includes("6 天"), "缺少历史最长");
  assert.ok(cards.includes("c-green"), "准时率 75% 应标绿色之外的判断有误");
  assert.ok(cards.includes("1 项已超时"), "缺少超时提示");
  assert.ok(cards.includes("2026-10-18"), "缺少单日最高记录日期");
  assert.ok(cards.includes("2 天"), "缺少平均计划提前量");
});

t("每日柱状图数量与窗口一致", () => {
  T.renderStats(sample);
  const bars = document.getElementById("dailyCols").innerHTML;
  assert.equal((bars.match(/class="col"/g) || []).length, 30);
});

t("星期柱状图是 7 根且标出最忙的一天", () => {
  T.renderStats(sample);
  const bars = document.getElementById("weekdayCols").innerHTML;
  assert.equal((bars.match(/class="col"/g) || []).length, 7);
  assert.ok(bars.includes("good"), "最忙的那天应有 good 类");
  assert.ok(document.getElementById("weekdaySub").textContent.includes("星期四"));
});

t("时段分布是 24 根并标出最忙时段", () => {
  T.renderStats(sample);
  const bars = document.getElementById("hourlyCols").innerHTML;
  assert.equal((bars.match(/class="col"/g) || []).length, 24);
  assert.ok(document.getElementById("hourlySub").textContent.includes("21:00"));
});

t("待办时间分布渲染成彩色标签", () => {
  T.renderStats(sample);
  const chips = document.getElementById("activeChips").innerHTML;
  assert.ok(chips.includes("已超时"));
  assert.ok(chips.includes("24 小时内到期"));
  assert.equal((chips.match(/class="chip"/g) || []).length, 5);
});

t("按时率过低显示红色", () => {
  T.renderStats(Object.assign({}, sample, {
    done: Object.assign({}, sample.done, { onTimeRate: 0.2 }),
  }));
  assert.ok(document.getElementById("statCards").innerHTML.includes("c-red"));
});

t("准时率为 null 显示占位符而不是 NaN", () => {
  T.renderStats(Object.assign({}, sample, {
    done: Object.assign({}, sample.done, { onTimeRate: null, onTime: 0, late: 0, total: 0 }),
  }));
  const cards = document.getElementById("statCards").innerHTML;
  assert.equal(cards.includes("NaN"), false);
  assert.ok(cards.includes("—"));
});

t("没有待办时给出空状态而不是空标签", () => {
  T.renderStats(Object.assign({}, sample, {
    active: { total: 0, overdue: 0, within1d: 0, within3d: 0, within7d: 0, later: 0 },
  }));
  assert.ok(document.getElementById("activeChips").innerHTML.includes("stats-empty"));
});

t("柱状图最大值为 1 时不会除零", () => {
  const el = document.getElementById("testCols");
  T.renderCols(el, [{ v: 0, tip: "a", label: "一" }, { v: 1, tip: "b", label: "二" }]);
  assert.equal(el.innerHTML.includes("NaN"), false);
  assert.ok(el.innerHTML.includes("height:64px"));
});

t("柱状图内容做了 HTML 转义", () => {
  const el = document.getElementById("testCols2");
  T.renderCols(el, [{ v: 1, tip: '<script>"x"</script>', label: "<b>" }]);
  assert.equal(el.innerHTML.includes("<script>"), false);
  assert.ok(el.innerHTML.includes("&lt;"));
});

console.log("\n[纪念：日期解析与倒计时]");
const DAY = 86400000;

// 相对今天造日期字符串，避免测试依赖具体某一天
function keyOf(offsetDays) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offsetDays);
  return T.dateKey(d);
}

t("parseDateKey 解析成当天 0 点", () => {
  const d = T.parseDateKey("2023-05-20");
  assert.equal(d.getFullYear(), 2023);
  assert.equal(d.getMonth(), 4);
  assert.equal(d.getDate(), 20);
  assert.equal(d.getHours(), 0);
});
t("parseDateKey 对脏数据返回 null", () => {
  assert.equal(T.parseDateKey(""), null);
  assert.equal(T.parseDateKey("2023/05/20"), null);
  assert.equal(T.parseDateKey(null), null);
});
t("今天就是纪念日 → kind=today", () => {
  const info = T.memorialInfo({ date: keyOf(0), repeat: "none" });
  assert.equal(info.kind, "today");
  assert.equal(info.days, 0);
});
t("10 天后 → future, 天数 10", () => {
  const info = T.memorialInfo({ date: keyOf(10), repeat: "none" });
  assert.equal(info.kind, "future");
  assert.equal(info.days, 10);
});
t("30 天前的一次性日期 → past, 天数 -30", () => {
  const info = T.memorialInfo({ date: keyOf(-30), repeat: "none" });
  assert.equal(info.kind, "past");
  assert.equal(info.days, -30);
});
t("每年重复：过去的日期也算出未来的下一次", () => {
  const info = T.memorialInfo({ date: "2020-01-15", repeat: "year" });
  assert.equal(info.kind === "future" || info.kind === "today", true);
  assert.ok(info.days >= 0 && info.days <= 366, "天数应在一年内，实际 " + info.days);
  assert.ok(info.years >= 6, "周年数应 ≥ 6，实际 " + info.years);
  assert.ok(info.totalDays > 0);
});
t("每年重复：2 月 29 日不会崩", () => {
  const info = T.memorialInfo({ date: "2024-02-29", repeat: "year" });
  assert.ok(info && info.days >= 0 && info.days <= 366);
});
t("repeat 缺省时按每年重复处理", () => {
  const info = T.memorialInfo({ date: "2020-01-15" });
  assert.equal(info.kind === "future" || info.kind === "today", true);
});
t("totalDays 是距今的总天数", () => {
  const info = T.memorialInfo({ date: keyOf(-100), repeat: "none" });
  assert.equal(info.totalDays, 100);
});
t("非法日期返回 null", () => {
  assert.equal(T.memorialInfo({ date: "abc" }), null);
});

console.log("\n[纪念：排序]");
t("今天在最前，未来按远近，过去的排最后", () => {
  const sorted = T.sortMemorials([
    { id: "p1", title: "过去1", date: keyOf(-100), repeat: "none" },
    { id: "f2", title: "未来远", date: keyOf(30), repeat: "none" },
    { id: "t", title: "今天", date: keyOf(0), repeat: "none" },
    { id: "f1", title: "未来近", date: keyOf(3), repeat: "none" },
    { id: "p2", title: "过去近", date: keyOf(-5), repeat: "none" },
  ]);
  // 注意：sorted 来自 vm 沙箱（另一个 realm），跨 realm 的数组不能用 deepEqual 比，
  // 会因为原型不同而误报，所以拼成字符串来比
  assert.equal(sorted.map((x) => x.m.id).join(","), "t,f1,f2,p2,p1");
});
t("脏数据不会让排序崩掉", () => {
  const sorted = T.sortMemorials([{ id: "x", title: "坏", date: "nope" }, { id: "y", title: "好", date: keyOf(1) }]);
  assert.equal(sorted.length, 1);
  assert.equal(sorted[0].m.id, "y");
});

console.log("\n[纪念：图标]");
t("按名称猜图标", () => {
  assert.equal(T.emojiOf({ title: "小明生日" }), "🎂");
  assert.equal(T.emojiOf({ title: "结婚纪念日" }), "💍");
  assert.equal(T.emojiOf({ title: "在一起" }), "💕");
  assert.equal(T.emojiOf({ title: "毕业" }), "🎓");
  assert.equal(T.emojiOf({ title: "随便什么" }), "🎗");
});
t("今天的纪念日固定用 🎉", () => {
  assert.equal(T.emojiOf({ title: "小明生日" }, { kind: "today" }), "🎉");
});

console.log("\n[纪念：列表渲染]");
t("空列表显示引导文案", () => {
  T.setMemorials([]);
  T.renderMemorials();
  assert.ok(document.getElementById("memList").innerHTML.includes("mem-empty"));
  assert.ok(document.getElementById("memSub").textContent.includes("重要的日子"));
});
t("列表条数与内容正确", () => {
  T.setMemorials([
    { id: "a", title: "在一起", date: keyOf(0), repeat: "year", note: "第一次见面" },
    { id: "b", title: "毕业", date: keyOf(-20), repeat: "none", note: "" },
  ]);
  T.renderMemorials();
  const html = document.getElementById("memList").innerHTML;
  assert.equal((html.match(/class="mem-item/g) || []).length, 2);
  assert.ok(html.includes("在一起"));
  assert.ok(html.includes("就是今天"));
  assert.ok(html.includes("第一次见面"));
  assert.ok(html.includes("已过 20 天"));
  assert.ok(html.includes("每年重复"));
  assert.ok(html.includes("只此一次"));
});
t("标题做了 HTML 转义", () => {
  T.setMemorials([{ id: "x", title: '<script>alert(1)</script>', date: keyOf(3), repeat: "none" }]);
  T.renderMemorials();
  const html = document.getElementById("memList").innerHTML;
  assert.equal(html.includes("<script>alert"), false);
  assert.ok(html.includes("&lt;script&gt;"));
});
t("近期（7 天内）会标上 soon 样式", () => {
  T.setMemorials([{ id: "s", title: "快到了", date: keyOf(3), repeat: "none" }]);
  T.renderMemorials();
  assert.ok(document.getElementById("memList").innerHTML.includes("mem-item soon"));
});

console.log("\n[纪念：主界面提示条]");
t("今天有纪念日 → 显示提示条", () => {
  T.setMemorials([{ id: "a", title: "在一起", date: keyOf(0), repeat: "year" }]);
  T.renderMemBanner();
  assert.equal(document.getElementById("memBanner").classList.contains("hidden"), false);
  assert.ok(document.getElementById("memBannerMain").textContent.includes("今天是"));
  assert.ok(document.getElementById("memBannerMain").textContent.includes("在一起"));
});
t("7 天内有纪念日 → 显示倒计时", () => {
  T.setMemorials([{ id: "b", title: "生日", date: keyOf(5), repeat: "none" }]);
  T.renderMemBanner();
  assert.equal(document.getElementById("memBanner").classList.contains("hidden"), false);
  assert.ok(document.getElementById("memBannerMain").textContent.includes("还有 5 天"));
});
t("都还很远 → 隐藏提示条", () => {
  T.setMemorials([{ id: "c", title: "很久以后", date: keyOf(200), repeat: "none" }]);
  T.renderMemBanner();
  assert.equal(document.getElementById("memBanner").classList.contains("hidden"), true);
});
t("没有纪念日 → 隐藏提示条", () => {
  T.setMemorials([]);
  T.renderMemBanner();
  assert.equal(document.getElementById("memBanner").classList.contains("hidden"), true);
});

console.log("\n[纪念：农历]");
t("农历月名与日名齐全", () => {
  assert.equal(T.LUNAR_MONTH_NAMES.length, 12);
  assert.equal(T.LUNAR_MONTH_NAMES[0], "正月");
  assert.equal(T.LUNAR_MONTH_NAMES[10], "冬月");
  assert.equal(T.LUNAR_DAY_NAMES.length, 30);
  assert.equal(T.LUNAR_DAY_NAMES[0], "初一");
  assert.equal(T.LUNAR_DAY_NAMES[29], "三十");
});
t("农历纪念日按服务端给的公历日期算倒计时", () => {
  const info = T.memorialInfo({
    calendar: "lunar",
    date: "1998-08-15",
    repeat: "year",
    lunarText: "八月十五",
    originalSolar: "1998-10-05",
    occurrences: [
      { lunarYear: 2026, solar: keyOf(12) },
      { lunarYear: 2027, solar: keyOf(380) },
    ],
  });
  assert.equal(info.kind, "future");
  assert.equal(info.days, 12);
  assert.equal(info.years, 28);           // 2026 - 1998
  assert.equal(info.lunarText, "八月十五");
  assert.ok(info.totalDays > 0);
});
t("农历今天就是纪念日", () => {
  const info = T.memorialInfo({
    calendar: "lunar", date: "2000-01-01", repeat: "year",
    lunarText: "正月初一", originalSolar: "2000-02-05",
    occurrences: [{ lunarYear: 2026, solar: keyOf(0) }, { lunarYear: 2027, solar: keyOf(354) }],
  });
  assert.equal(info.kind, "today");
  assert.equal(info.days, 0);
});
t("跳过已经过去的换算结果，取下一次", () => {
  const info = T.memorialInfo({
    calendar: "lunar", date: "2000-01-01", repeat: "year",
    lunarText: "正月初一", originalSolar: "2000-02-05",
    occurrences: [
      { lunarYear: 2025, solar: keyOf(-100) },  // 已过去
      { lunarYear: 2026, solar: keyOf(30) },
    ],
  });
  assert.equal(info.days, 30);
});
t("农历一次性纪念日（已过）算成 past", () => {
  const info = T.memorialInfo({
    calendar: "lunar", date: "2000-01-01", repeat: "none",
    lunarText: "正月初一", originalSolar: keyOf(-40),
  });
  assert.equal(info.kind, "past");
  assert.equal(info.days, -40);
});
t("农历数据缺失时返回 null 而不是崩掉", () => {
  assert.equal(T.memorialInfo({ calendar: "lunar", date: "2000-01-01", repeat: "year" }), null);
});
t("列表里显示农历文本与对应公历", () => {
  T.setMemorials([{
    id: "L", title: "外婆生日", calendar: "lunar", date: "1940-08-15", repeat: "year",
    lunarText: "八月十五", originalSolar: "1940-09-16",
    occurrences: [{ lunarYear: 2026, solar: keyOf(20) }, { lunarYear: 2027, solar: keyOf(390) }],
  }]);
  T.renderMemorials();
  const html = document.getElementById("memList").innerHTML;
  assert.ok(html.includes("农历八月十五"), "缺少农历文本");
  assert.ok(html.includes("公历 " + keyOf(20)), "缺少换算后的公历日期");
  assert.ok(html.includes("第 86 周年"), "缺少周年数");
});

console.log(`\n结果：${pass} 通过，${fail} 失败\n`);
process.exit(fail ? 1 : 0);
