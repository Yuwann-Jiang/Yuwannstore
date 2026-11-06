// 倒计时型待办（`auto: true`）的自动结算
//
// 需求：有些待办不需要"点完成"，比如「12 月 20 日考试」——
// 时间一到它自己就该算完成了，而不是一直挂在列表里变成"已超时"。
//
// 结算策略：**惰性结算 + 定时兜底**，两边都做
//   1. 惰性：任何人读待办列表（GET /api/todos）时顺手结算一遍
//      → 用户打开 App 的瞬间看到的就是正确状态，不用等定时任务
//   2. 兜底：定时任务（每 15 分钟）扫所有用户结算一遍
//      → 用户几天不开 App，热力图和统计里也不会漏掉这一天
//
// 为什么两处都要：只有定时任务会有最多 15 分钟的"已经到期却还挂在列表里"；
// 只有惰性结算则用户不开 App 就永远不结算，完成记录（热力图/统计/年度总结）
// 会缺数据。两处都实现且都幂等，才既及时又不丢。
//
// 幂等：结算会把这些待办从 `todos:*` 里删掉并写入 `completions:*`，
// 同一件事不会被结算两次（第二次扫描时它已经不在待办列表里了）。

// 完成记录上限（与 api.js / notify.js 共用）
export const MAX_COMPLETIONS = 3000;

// 是否是倒计时型待办
export function isAutoTodo(todo) {
  return !!(todo && todo.auto === true);
}

// 是否已到期（到了该自动完成的时候）
export function isAutoDue(todo, now = Date.now()) {
  return isAutoTodo(todo) && Number.isFinite(todo.deadline) && todo.deadline <= now;
}

/**
 * 结算一组待办：把"到期的倒计时待办"挑出来，剩下的原样返回。
 * 纯函数，不改入参。
 *
 * @returns {{ kept: Array, completed: Array<{todo: object, at: number}> }}
 */
export function settleAutoTodos(todos, now = Date.now()) {
  const kept = [];
  const completed = [];
  for (const t of Array.isArray(todos) ? todos : []) {
    if (!t || typeof t !== "object") continue;
    if (isAutoDue(t, now)) completed.push({ todo: t, at: t.deadline });
    else kept.push(t);
  }
  return { kept, completed };
}

/**
 * 造一条完成记录。
 * @param {object} todo  待办
 * @param {number} at    完成时间戳（自动完成时传截止时间，而不是"现在"）
 * @param {string} id    记录 id
 */
export function makeCompletion(todo, at, id) {
  const deadline = Number.isFinite(todo && todo.deadline) ? todo.deadline : null;
  // 自动完成时 at 就是截止时间，所以一定"准时"；
  // 手动完成时按 at <= deadline 判断。
  const onTime = deadline === null ? null : at <= deadline;
  return {
    id,
    text: String((todo && todo.text) ?? "").slice(0, 200),
    at,
    deadline,
    onTime,
  };
}

/**
 * 把新记录追加到完成历史末尾，并按上限裁掉最旧的。
 * 返回新数组，不改入参。
 */
export function appendCompletions(existing, records, cap = MAX_COMPLETIONS) {
  const list = Array.isArray(existing) ? existing.slice() : [];
  for (const r of Array.isArray(records) ? records : []) list.push(r);
  return list.length > cap ? list.slice(-cap) : list;
}
