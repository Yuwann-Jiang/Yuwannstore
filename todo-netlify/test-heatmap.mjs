// 热力图逻辑测试：直接从 public/index.html 中提取真实函数来验证，
// 避免"测试副本"与线上代码脱节。
//
// 运行：node test-heatmap.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(HERE, "public", "index.html"), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

// 按大括号配对，从源码中精确截取一个函数
function grabFn(name) {
  const start = script.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`找不到函数 ${name}`);
  let i = script.indexOf("{", start);
  let depth = 0;
  for (let j = i; j < script.length; j++) {
    if (script[j] === "{") depth++;
    else if (script[j] === "}") {
      depth--;
      if (depth === 0) return script.slice(start, j + 1);
    }
  }
  throw new Error(`函数 ${name} 括号不配对`);
}

const src = ["dateKey", "levelOf", "groupByDay", "calcStreak"].map(grabFn).join("\n");
const mod = new Function("completions", `${src}; return { dateKey, levelOf, groupByDay, calcStreak };`);

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

const DAY = 86400000;
const now = Date.now();
const at = (daysAgo, hour = 12) => {
  const d = new Date(now - daysAgo * DAY);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
};

console.log("=== 1. 日期键格式化（本地时区）===");
{
  const m = mod([]);
  chk("补零正确", m.dateKey(new Date(2026, 0, 5)), "2026-01-05");
  chk("普通日期", m.dateKey(new Date(2026, 8, 28)), "2026-09-28");
  chk("跨年边界", m.dateKey(new Date(2025, 11, 31)), "2025-12-31");
}

console.log("\n=== 2. 颜色分级 ===");
{
  const m = mod([]);
  chk("0 项 → 等级 0", m.levelOf(0), 0);
  chk("1 项 → 等级 1", m.levelOf(1), 1);
  chk("2 项 → 等级 2", m.levelOf(2), 2);
  chk("3 项 → 等级 2（边界）", m.levelOf(3), 2);
  chk("4 项 → 等级 3（边界）", m.levelOf(4), 3);
  chk("5 项 → 等级 3（边界）", m.levelOf(5), 3);
  chk("6 项 → 等级 4（边界）", m.levelOf(6), 4);
  chk("50 项 → 等级 4", m.levelOf(50), 4);
  chk("负数按 0 处理", m.levelOf(-1), 0);
}

console.log("\n=== 3. 按天归组 ===");
{
  // 今天 3 条、昨天 1 条、前天 0 条、5 天前 6 条
  const data = [
    { text: "a", at: at(0, 9) },
    { text: "b", at: at(0, 11) },
    { text: "c", at: at(0, 20) },
    { text: "d", at: at(1, 15) },
    { text: "e", at: at(5, 8) },
    { text: "f", at: at(5, 9) },
    { text: "g", at: at(5, 10) },
    { text: "h", at: at(5, 11) },
    { text: "i", at: at(5, 12) },
    { text: "j", at: at(5, 13) },
  ];
  const m = mod(data);
  const byDay = m.groupByDay();
  const k0 = m.dateKey(new Date(at(0)));
  const k1 = m.dateKey(new Date(at(1)));
  const k5 = m.dateKey(new Date(at(5)));

  chk("今天 3 条", byDay.get(k0).length, 3);
  chk("昨天 1 条", byDay.get(k1).length, 1);
  chk("5 天前 6 条", byDay.get(k5).length, 6);
  chkTrue("无记录的日期不出现在 map 中", !byDay.has(m.dateKey(new Date(at(3)))));
  chk("同一天内按时间升序", byDay.get(k0).map((x) => x.text), ["a", "b", "c"]);
  chk("无效记录被跳过", mod([{ text: "x" }, null, { text: "y", at: at(0) }]).groupByDay().get(k0).length, 1);
}

console.log("\n=== 4. 连续天数统计 ===");
{
  // 今天、昨天、前天都有记录 → 连续 3 天
  const streak3 = mod([
    { at: at(0) }, { at: at(1) }, { at: at(2) },
  ]).calcStreak(mod([{ at: at(0) }, { at: at(1) }, { at: at(2) }]).groupByDay());
  chk("连续 3 天", streak3, 3);

  // 今天没有，但昨天前天有 → 仍然算连续 2 天
  const m2data = [{ at: at(1) }, { at: at(2) }];
  const m2 = mod(m2data);
  chk("今天未完成但昨天有 → 连续 2 天", m2.calcStreak(m2.groupByDay()), 2);

  // 中间断档 → 只算到今天之前的连续段
  const m3 = mod([{ at: at(0) }, { at: at(1) }, { at: at(3) }]);
  chk("中间断档 → 连续 2 天", m3.calcStreak(m3.groupByDay()), 2);

  // 完全没有记录
  const m4 = mod([]);
  chk("无记录 → 0 天", m4.calcStreak(m4.groupByDay()), 0);

  // 昨天和前天都没记录（今天也没）
  const m5 = mod([{ at: at(3) }, { at: at(4) }]);
  chk("最近两天都没记录 → 0 天", m5.calcStreak(m5.groupByDay()), 0);
}

console.log("\n=== 5. 跨天归属（23:59 与 00:01 应分属不同天）===");
{
  const d1 = new Date(now);
  d1.setHours(0, 1, 0, 0);
  const d2 = new Date(now);
  d2.setHours(23, 59, 0, 0);
  const m = mod([{ text: "凌晨", at: d1.getTime() }, { text: "深夜", at: d2.getTime() }]);
  const byDay = m.groupByDay();
  chkTrue("同一天的两条归入同一天", byDay.size === 1 && [...byDay.values()][0].length === 2,
    `共 ${byDay.size} 天`);
}

console.log(`\n===== 结果: 通过 ${pass} 项, 失败 ${fail} 项 =====`);
process.exit(fail === 0 ? 0 : 1);
