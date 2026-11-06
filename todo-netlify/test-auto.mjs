// 倒计时待办（auto）的结算逻辑自测：node test-auto.mjs
//
// 覆盖：
//   · 只有 auto:true 且已经到期的才会被结算
//   · 结算时完成时间取「截止时间」而不是「现在」（决定热力图落在哪一天）
//   · 幂等：结算过的不会重复记
//   · 完成记录上限裁剪

import assert from "node:assert/strict";
import {
  isAutoTodo, isAutoDue, settleAutoTodos, makeCompletion, appendCompletions, MAX_COMPLETIONS,
} from "./lib/auto.js";

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

const NOW = Date.parse("2026-12-20T04:00:00Z"); // 北京时间 12:00
const HOUR = 3600000;

console.log("\n[判定]");
t("auto:true 才算倒计时型", () => {
  assert.equal(isAutoTodo({ auto: true }), true);
  assert.equal(isAutoTodo({ auto: false }), false);
  assert.equal(isAutoTodo({}), false);
  assert.equal(isAutoTodo(null), false);
  assert.equal(isAutoTodo({ auto: "true" }), false, "只认真正的布尔 true");
});
t("到期判断含边界（deadline == now 就算到期）", () => {
  assert.equal(isAutoDue({ auto: true, deadline: NOW }, NOW), true);
  assert.equal(isAutoDue({ auto: true, deadline: NOW - 1 }, NOW), true);
  assert.equal(isAutoDue({ auto: true, deadline: NOW + 1 }, NOW), false);
});
t("非倒计时型永远不到期", () => {
  assert.equal(isAutoDue({ deadline: NOW - HOUR }, NOW), false);
});
t("截止时间非法不算到期", () => {
  assert.equal(isAutoDue({ auto: true, deadline: NaN }, NOW), false);
  assert.equal(isAutoDue({ auto: true }, NOW), false);
  assert.equal(isAutoDue({ auto: true, deadline: "2026-12-20" }, NOW), false);
});

console.log("\n[结算]");
t("只挑出到期的 auto 待办", () => {
  const todos = [
    { id: "1", text: "已到期的考试", auto: true, deadline: NOW - HOUR },
    { id: "2", text: "还没到的考试", auto: true, deadline: NOW + HOUR },
    { id: "3", text: "普通待办（已超时）", deadline: NOW - HOUR },
    { id: "4", text: "普通待办", deadline: NOW + HOUR },
  ];
  const { kept, completed } = settleAutoTodos(todos, NOW);
  assert.deepEqual(kept.map((x) => x.id), ["2", "3", "4"]);
  assert.deepEqual(completed.map((x) => x.todo.id), ["1"]);
});
t("普通待办即使超时也不会被自动完成", () => {
  const { kept, completed } = settleAutoTodos(
    [{ id: "x", text: "普通", deadline: NOW - 100 * HOUR }], NOW);
  assert.equal(completed.length, 0);
  assert.equal(kept.length, 1);
});
t("结算时间是截止时间，不是现在", () => {
  const deadline = NOW - 5 * HOUR;
  const { completed } = settleAutoTodos([{ id: "a", text: "考试", auto: true, deadline }], NOW);
  assert.equal(completed[0].at, deadline);
});
t("空列表 / 脏数据不崩", () => {
  assert.deepEqual(settleAutoTodos([], NOW), { kept: [], completed: [] });
  assert.deepEqual(settleAutoTodos(null, NOW), { kept: [], completed: [] });
  const r = settleAutoTodos([null, undefined, "x", 5], NOW);
  assert.equal(r.kept.length, 0);
  assert.equal(r.completed.length, 0);
});
t("不改动入参", () => {
  const todos = [{ id: "1", auto: true, deadline: NOW - HOUR }];
  settleAutoTodos(todos, NOW);
  assert.equal(todos.length, 1);
});
t("幂等：结算过的结果再结算一次什么都不剩", () => {
  const todos = [
    { id: "1", text: "考试", auto: true, deadline: NOW - HOUR },
    { id: "2", text: "普通", deadline: NOW + HOUR },
  ];
  const first = settleAutoTodos(todos, NOW);
  const second = settleAutoTodos(first.kept, NOW);
  assert.equal(first.completed.length, 1);
  assert.equal(second.completed.length, 0);
});

console.log("\n[完成记录]");
t("自动完成的记录一定算准时", () => {
  const deadline = NOW - 5 * HOUR;
  const rec = makeCompletion({ text: "考试", deadline }, deadline, "id1");
  assert.equal(rec.at, deadline);
  assert.equal(rec.deadline, deadline);
  assert.equal(rec.onTime, true);
});
t("手动完成的记录按实际时间判断", () => {
  const deadline = NOW;
  assert.equal(makeCompletion({ deadline }, NOW - HOUR, "a").onTime, true);
  assert.equal(makeCompletion({ deadline }, NOW + HOUR, "b").onTime, false);
});
t("没有截止时间的记录 onTime 为 null", () => {
  assert.equal(makeCompletion({ text: "x" }, NOW, "c").onTime, null);
});
t("文本截到 200 字", () => {
  const rec = makeCompletion({ text: "字".repeat(500), deadline: NOW }, NOW, "d");
  assert.equal(rec.text.length, 200);
});

console.log("\n[上限裁剪]");
t("追加后按上限裁掉最旧的", () => {
  const existing = Array.from({ length: 5 }, (_, i) => ({ id: "old" + i }));
  const merged = appendCompletions(existing, [{ id: "new" }], 5);
  assert.equal(merged.length, 5);
  assert.equal(merged[merged.length - 1].id, "new");
  assert.equal(merged[0].id, "old1", "最旧的那条应被裁掉");
});
t("未超上限时原样追加", () => {
  const merged = appendCompletions([{ id: "a" }], [{ id: "b" }], 10);
  assert.deepEqual(merged.map((x) => x.id), ["a", "b"]);
});
t("空输入也能工作", () => {
  assert.deepEqual(appendCompletions(null, null, 10), []);
  assert.deepEqual(appendCompletions([], [{ id: "a" }], 10).map((x) => x.id), ["a"]);
});
t("默认上限是 3000", () => {
  assert.equal(MAX_COMPLETIONS, 3000);
});

console.log(`\n结果：${pass} 通过，${fail} 失败\n`);
process.exit(fail ? 1 : 0);
