// 定时任务：每 15 分钟检查一次，给「剩余不足 1 天且尚未提醒过」的待办发提醒邮件
import { getStore } from "@netlify/blobs";
import { createMailer, runNotify } from "../../lib/notify.js";

export default async function handler(req) {
  const started = Date.now();

  // ⚠️ 这里**不能**用 consistency:"strong" 的实例！
  // runNotify 需要 list() 枚举所有用户，而 @netlify/blobs 的 list() 无法按次
  // 指定一致性，会被存储实例的 strong 设置带去不支持列举的 uncached 端点，
  // 结果是「永远扫不到用户」且不报错（邮件提醒曾因此静默失效）。
  // get() 的强一致读由 runNotify 内部按次传入，不受影响。
  const store = getStore({ name: "todo-app" });
  const mailer = createMailer();

  const from = process.env.QQ_USER;
  const appUrl = process.env.APP_URL || "https://yuwann-todo.netlify.app/";

  const result = await runNotify({ store, mailer, from, appUrl });
  result.elapsedMs = Date.now() - started;

  // 记录本次运行，用于确认定时器是否真的在自动执行（见 /api/notify-status）
  try {
    await store.setJSON("notify:lastRun", {
      at: Date.now(),
      trigger: "schedule",
      scannedUsers: result.scannedUsers,
      scannedTodos: result.scannedTodos,
      sent: result.sent,
      failed: result.failed,
      error: result.error || null,
    });
  } catch (e) {
    console.error("写入运行记录失败:", e);
  }

  console.log("【待办提醒任务】", JSON.stringify(result));

  return new Response(JSON.stringify({ ok: !result.error, ...result }), {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

// 每 15 分钟执行一次
export const config = { schedule: "*/15 * * * *" };
