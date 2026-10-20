// 纪念日的校验逻辑自测：node test-memorial.mjs
//
// 重点覆盖日期合法性 —— 这是最容易出错的地方：
//   · 2023-02-30、2023-04-31 这种"格式对但不存在"的日期必须拒掉
//   · 闰年 2024-02-29 要接受，平年 2023-02-29 要拒绝
//   · "2023-2-3"（没补零）要拒绝，否则前端 <input type="date"> 会对不上

import assert from "node:assert/strict";
import {
  normalizeDate, normalizeTitle, normalizeNote, normalizeRepeat,
  validateMemorial, MAX_TITLE_LEN, MAX_NOTE_LEN, MAX_MEMORIALS, REPEAT_VALUES,
} from "./lib/memorial.js";

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

console.log("\n[日期校验]");
t("正常日期通过", () => {
  assert.equal(normalizeDate("2023-05-20"), "2023-05-20");
  assert.equal(normalizeDate("1999-12-31"), "1999-12-31");
  assert.equal(normalizeDate("2026-01-01"), "2026-01-01");
});
t("闰年 2 月 29 日通过", () => {
  assert.equal(normalizeDate("2024-02-29"), "2024-02-29");
  assert.equal(normalizeDate("2000-02-29"), "2000-02-29");
});
t("平年 2 月 29 日被拒", () => {
  assert.equal(normalizeDate("2023-02-29"), null);
  assert.equal(normalizeDate("1900-02-29"), null); // 1900 不是闰年（世纪年）
});
t("不存在的日期被拒", () => {
  assert.equal(normalizeDate("2023-02-30"), null);
  assert.equal(normalizeDate("2023-04-31"), null);
  assert.equal(normalizeDate("2023-00-10"), null);
  assert.equal(normalizeDate("2023-13-01"), null);
  assert.equal(normalizeDate("2023-01-00"), null);
});
t("格式不对被拒（必须补零）", () => {
  assert.equal(normalizeDate("2023-2-3"), null);
  assert.equal(normalizeDate("2023/05/20"), null);
  assert.equal(normalizeDate("20230520"), null);
  assert.equal(normalizeDate("abc"), null);
  assert.equal(normalizeDate(""), null);
  assert.equal(normalizeDate(null), null);
  assert.equal(normalizeDate(undefined), null);
});
t("年份范围外被拒", () => {
  assert.equal(normalizeDate("1899-12-31"), null);
  assert.equal(normalizeDate("2201-01-01"), null);
});
t("首尾空格会被去掉", () => {
  assert.equal(normalizeDate("  2023-05-20 "), "2023-05-20");
});
t("时间戳不会被当成日期", () => {
  assert.equal(normalizeDate(1690000000000), null);
});

console.log("\n[名称与备注]");
t("名称去空格并限长", () => {
  assert.equal(normalizeTitle("  在一起  "), "在一起");
  assert.equal(normalizeTitle(""), null);
  assert.equal(normalizeTitle("   "), null);
  assert.equal(normalizeTitle(null), null);
  assert.equal(normalizeTitle("字".repeat(100)).length, MAX_TITLE_LEN);
});
t("备注可以为空，超长截断", () => {
  assert.equal(normalizeNote(""), "");
  assert.equal(normalizeNote(undefined), "");
  assert.equal(normalizeNote("  第一年  "), "第一年");
  assert.equal(normalizeNote("字".repeat(500)).length, MAX_NOTE_LEN);
});

console.log("\n[重复方式]");
t("默认每年重复", () => {
  assert.equal(normalizeRepeat(undefined), "year");
  assert.equal(normalizeRepeat(""), "year");
});
t("合法值通过、大小写不敏感", () => {
  assert.equal(normalizeRepeat("year"), "year");
  assert.equal(normalizeRepeat("NONE"), "none");
  assert.deepEqual(REPEAT_VALUES, ["year", "none"]);
});
t("非法值被拒", () => {
  assert.equal(normalizeRepeat("month"), null);
  assert.equal(normalizeRepeat("day"), null);
});

console.log("\n[完整校验：新建]");
t("最小输入即可通过，并补上默认值", () => {
  const v = validateMemorial({ title: "在一起", date: "2023-05-20" });
  assert.equal(v.ok, true);
  assert.deepEqual(v.value, { title: "在一起", date: "2023-05-20", repeat: "year", note: "" });
});
t("缺名称被拒", () => {
  const v = validateMemorial({ date: "2023-05-20" });
  assert.equal(v.ok, false);
  assert.match(v.error, /名称/);
});
t("缺日期被拒", () => {
  const v = validateMemorial({ title: "在一起" });
  assert.equal(v.ok, false);
  assert.match(v.error, /日期/);
});
t("非法日期被拒", () => {
  const v = validateMemorial({ title: "x", date: "2023-02-30" });
  assert.equal(v.ok, false);
});
t("非法重复方式被拒", () => {
  const v = validateMemorial({ title: "x", date: "2023-05-20", repeat: "weekly" });
  assert.equal(v.ok, false);
});
t("请求体不是对象被拒", () => {
  assert.equal(validateMemorial(null).ok, false);
  assert.equal(validateMemorial("abc").ok, false);
});

console.log("\n[完整校验：编辑]");
t("只传一个字段也能通过", () => {
  const v = validateMemorial({ title: "改个名" }, { partial: true });
  assert.equal(v.ok, true);
  assert.deepEqual(v.value, { title: "改个名" });
});
t("编辑时不会写入默认值", () => {
  const v = validateMemorial({ date: "2024-01-01" }, { partial: true });
  assert.deepEqual(v.value, { date: "2024-01-01" });
  assert.equal("repeat" in v.value, false);
  assert.equal("note" in v.value, false);
});
t("编辑时字段非法照样被拒", () => {
  assert.equal(validateMemorial({ date: "2024-02-30" }, { partial: true }).ok, false);
  assert.equal(validateMemorial({ title: "  " }, { partial: true }).ok, false);
});
t("什么都没传被拒", () => {
  const v = validateMemorial({}, { partial: true });
  assert.equal(v.ok, false);
  assert.match(v.error, /没有要修改/);
});
t("编辑可以把备注清空", () => {
  const v = validateMemorial({ note: "" }, { partial: true });
  assert.equal(v.ok, true);
  assert.equal(v.value.note, "");
});

console.log("\n[常量]");
t("上限值合理", () => {
  assert.equal(MAX_MEMORIALS, 500);
  assert.equal(MAX_TITLE_LEN, 50);
  assert.equal(MAX_NOTE_LEN, 200);
});

console.log(`\n结果：${pass} 通过，${fail} 失败\n`);
process.exit(fail ? 1 : 0);
