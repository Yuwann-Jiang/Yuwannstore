// 待办到期提醒：核心逻辑
// 被两个入口共用：
//   1. netlify/functions/notify.js  —— 定时任务（cron）
//   2. netlify/functions/api.js     —— 手动触发接口（便于测试）
//
// 邮件发送使用自己实现的极简 SMTP 客户端（基于 node:tls），
// 不依赖 nodemailer —— 第三方邮件库会让 Netlify 的函数打包阶段卡死。

import tls from "node:tls";
import net from "node:net";
import { settleAutoTodos, makeCompletion, appendCompletions, MAX_COMPLETIONS } from "./auto.js";

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// 极简 SMTP 客户端
// ---------------------------------------------------------------------------
function b64(s) {
  return Buffer.from(s, "utf8").toString("base64");
}

// 按行读取响应，支持多行响应（如 EHLO 的 250-xxx）
function makeLineReader(socket) {
  let buffer = "";
  const queue = [];
  let waiter = null;

  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let idx;
    while ((idx = buffer.indexOf("\r\n")) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      if (waiter) {
        const w = waiter;
        waiter = null;
        w(line);
      } else {
        queue.push(line);
      }
    }
  });

  function nextLine() {
    if (queue.length) return Promise.resolve(queue.shift());
    return new Promise((resolve) => {
      waiter = resolve;
    });
  }

  // 读到「最终行」（形如 "250 xxx"，第 4 位是空格而非连字符）为止
  async function readResponse() {
    const lines = [];
    for (;;) {
      const line = await nextLine();
      lines.push(line);
      if (/^\d{3} /.test(line)) {
        return { code: Number(line.slice(0, 3)), lines };
      }
    }
  }

  return { readResponse };
}

export async function smtpSend({
  host, port, secure = true, user, pass, from, to, subject, text, html, timeoutMs = 20000,
}) {
  const message = buildMessage({ from, to, subject, text, html });

  return await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err, val) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* 忽略 */ }
      if (err) reject(err);
      else resolve(val);
    };

    const socket = secure
      ? tls.connect({ host, port, servername: host })
      : net.connect({ host, port });

    socket.setTimeout(timeoutMs, () => finish(new Error(`SMTP 连接超时（${timeoutMs}ms）`)));
    socket.on("error", (e) => finish(new Error("SMTP 连接错误: " + e.message)));

    const { readResponse } = makeLineReader(socket);

    (async () => {
      const expect = async (code, stage) => {
        const r = await readResponse();
        if (r.code !== code) {
          throw new Error(`${stage} 失败，SMTP 返回 ${r.code}: ${r.lines.join(" / ")}`);
        }
        return r;
      };
      const send = (line) => socket.write(line);

      await expect(220, "连接握手");

      send("EHLO localhost\r\n");
      await expect(250, "EHLO");

      send("AUTH LOGIN\r\n");
      await expect(334, "AUTH LOGIN");

      send(b64(user) + "\r\n");
      await expect(334, "发送用户名");

      send(b64(pass) + "\r\n");
      await expect(235, "密码认证");

      send(`MAIL FROM:<${from}>\r\n`);
      await expect(250, "MAIL FROM");

      send(`RCPT TO:<${to}>\r\n`);
      const rcpt = await readResponse();
      if (rcpt.code !== 250 && rcpt.code !== 251) {
        throw new Error(`收件人被拒绝，SMTP 返回 ${rcpt.code}: ${rcpt.lines.join(" / ")}`);
      }

      send("DATA\r\n");
      await expect(354, "DATA");

      send(message + "\r\n.\r\n");
      await expect(250, "投递邮件");

      // 礼貌断开：发出 QUIT 并等服务器回应（最多 1 秒），确保数据已刷新，
      // 否则立刻销毁 socket 会丢掉 QUIT，部分服务器会记为异常断开。
      send("QUIT\r\n");
      await Promise.race([
        readResponse().catch(() => null),
        new Promise((r) => setTimeout(r, 1000)),
      ]);

      finish(null, true);
    })().catch(finish);
  });
}

// 构造 RFC 5322 邮件报文（正文用 base64，避免点号转义与行长限制）
export function buildMessage({ from, to, subject, text, html }) {
  const boundary = "todo-" + Math.random().toString(36).slice(2, 12);
  const date = new Date().toUTCString();
  const msgId = `<${Date.now()}.${Math.random().toString(36).slice(2, 10)}@qq.com>`;

  const headers = [
    `From: =?UTF-8?B?${b64("待办提醒")}?= <${from}>`,
    `To: <${to}>`,
    `Subject: =?UTF-8?B?${b64(subject)}?=`,
    `Date: ${date}`,
    `Message-ID: ${msgId}`,
    "MIME-Version: 1.0",
  ];

  if (html) {
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    const body =
      `--${boundary}\r\n` +
      "Content-Type: text/plain; charset=UTF-8\r\n" +
      "Content-Transfer-Encoding: base64\r\n\r\n" +
      wrap76(b64(text || "")) + "\r\n" +
      `--${boundary}\r\n` +
      "Content-Type: text/html; charset=UTF-8\r\n" +
      "Content-Transfer-Encoding: base64\r\n\r\n" +
      wrap76(b64(html)) + "\r\n" +
      `--${boundary}--`;
    return headers.join("\r\n") + "\r\n\r\n" + body;
  }

  headers.push("Content-Type: text/plain; charset=UTF-8");
  headers.push("Content-Transfer-Encoding: base64");
  return headers.join("\r\n") + "\r\n\r\n" + wrap76(b64(text || ""));
}

function wrap76(s) {
  return s.replace(/(.{76})/g, "$1\r\n");
}

// ---------------------------------------------------------------------------
// 邮件发送器（QQ 邮箱 SMTP）
// ---------------------------------------------------------------------------
export function createMailer() {
  const user = process.env.QQ_USER;
  const pass = process.env.QQ_AUTH_CODE;
  if (!user || !pass) return null;

  const host = process.env.SMTP_HOST || "smtp.qq.com";
  const port = Number(process.env.SMTP_PORT || 465);
  const secure = process.env.SMTP_SECURE !== "0";

  return {
    async sendMail({ from, to, subject, text, html }) {
      return smtpSend({ host, port, secure, user, pass, from, to, subject, text, html });
    },
  };
}

// ---------------------------------------------------------------------------
// 格式化
// ---------------------------------------------------------------------------
export function fmtDeadline(ts) {
  return new Date(ts).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function fmtRemain(ms) {
  if (ms < 0) {
    const abs = -ms;
    const d = Math.floor(abs / DAY_MS);
    const h = Math.floor((abs % DAY_MS) / 3600000);
    const m = Math.floor((abs % 3600000) / 60000);
    return `已超时 ${d > 0 ? d + "天" : ""}${h}小时${m}分`;
  }
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return `剩余 ${h}小时${m}分`;
}

// ---------------------------------------------------------------------------
// 多级提醒：按紧急程度递增的三个阶段
//   3d      剩余 ≤ 3 天        预告
//   1d      剩余 ≤ 1 天        正式提醒
//   overdue 已超过截止时间      催办
// 每个阶段最多发一次；若待办直接跳到更紧急的阶段，会跳过中间档（不补发）。
// ---------------------------------------------------------------------------
export const STAGES = ["3d", "1d", "overdue"];

const STAGE_META = {
  "3d": {
    label: "还有 3 天",
    title: "待办还有 3 天到期",
    accent: "#eab308",
    advice: "还有几天时间，可以安排一下节奏。",
  },
  "1d": {
    label: "即将到期",
    title: "待办即将到期",
    accent: "#e5484d",
    advice: "不到 24 小时了，建议优先处理。",
  },
  overdue: {
    label: "已超时",
    title: "待办已超时",
    accent: "#b91c1c",
    advice: "已经超过截止时间，请尽快完成或调整时间。",
  },
};

// 根据剩余时间判断当前应处于哪个提醒阶段；返回 null 表示还不到提醒时机
export function currentStage(remain) {
  if (remain < 0) return "overdue";
  if (remain <= DAY_MS) return "1d";
  if (remain <= 3 * DAY_MS) return "3d";
  return null;
}

// 读取某条待办已经发过哪些阶段（兼容旧版本的 notified 布尔字段）
export function sentStages(todo) {
  if (Array.isArray(todo.notifiedStages)) return todo.notifiedStages.slice();
  // 旧版本只在"剩余不足 1 天"时发过一次，视为 3d 与 1d 两档都已发
  if (todo.notified === true) return ["3d", "1d"];
  return [];
}

// ---------------------------------------------------------------------------
// 邮件内容（按阶段生成不同文案与配色）
// ---------------------------------------------------------------------------
export function renderEmail({ todo, remain, appUrl, stage }) {
  const st = stage || currentStage(remain) || "1d";
  const meta = STAGE_META[st] || STAGE_META["1d"];

  // 倒计时型待办（auto）不需要"去处理"，所以文案改成"还有多久"，
  // 并明确说明到期会自动完成，免得用户以为还得点什么。
  const isAuto = todo.auto === true;
  const autoTitle =
    st === "overdue" ? "倒计时已结束" : st === "1d" ? "倒计时还剩不到 1 天" : "倒计时还剩 3 天";
  const title = isAuto ? autoTitle : meta.title;
  const advice = isAuto
    ? (st === "1d" ? "明天就是这个日子，记得安排一下。" : "可以提前准备起来了。")
    : meta.advice;

  const subject = `${st === "overdue" ? "⚠️" : st === "1d" ? "⏰" : "⏳"} ${title}：${todo.text}`;

  const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:24px;background:#f4f6fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;">
  <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;border:1px solid #e5e7eb;">
    <div style="background:${isAuto ? "#4f46e5" : meta.accent};padding:18px 22px;color:#fff;">
      <div style="font-size:13px;opacity:.9;">待办提醒</div>
      <div style="font-size:19px;font-weight:600;margin-top:4px;">${title}</div>
    </div>
    <div style="padding:22px;">
      <div style="font-size:17px;font-weight:600;color:#1f2933;line-height:1.5;word-break:break-word;">${escapeHtml(todo.text)}</div>
      <table style="margin-top:16px;border-collapse:collapse;font-size:14px;color:#6b7280;">
        <tr><td style="padding:4px 12px 4px 0;">截止时间</td><td style="color:#1f2933;">${fmtDeadline(todo.deadline)}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;">时间状态</td><td style="color:${meta.accent};font-weight:600;">${fmtRemain(remain)}</td></tr>
      </table>
      <p style="color:#4b5563;font-size:13.5px;margin-top:14px;line-height:1.6;">${advice}</p>
      ${isAuto ? '<p style="color:#6b7280;font-size:12.5px;margin-top:6px;line-height:1.6;">这是一条倒计时事项，到时间会自动完成，不需要手动操作。</p>' : ""}
      <div style="margin-top:20px;">
        <a href="${appUrl}" style="display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;padding:11px 20px;border-radius:9px;font-size:14px;">打开待办清单</a>
      </div>
      <p style="color:#9aa5b1;font-size:12px;margin-top:22px;line-height:1.6;">提醒分三档：剩余 3 天、剩余 1 天、已超时。每档只会收到一次。</p>
    </div>
  </div>
</body></html>`;

  const text =
    `【${title}】${todo.text}\n` +
    `截止时间：${fmtDeadline(todo.deadline)}\n` +
    `时间状态：${fmtRemain(remain)}\n` +
    `${advice}\n` +
    `打开待办清单：${appUrl}\n`;

  return { subject, html, text, stage: st };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// ---------------------------------------------------------------------------
// 主流程：遍历所有用户，给「剩余不足 1 天且尚未提醒过」的待办发邮件
// ---------------------------------------------------------------------------
export async function runNotify({ store, mailer, from, appUrl, now = Date.now(), dryRun = false }) {
  const result = { scannedUsers: 0, scannedTodos: 0, due: 0, sent: 0, failed: 0, autoSettled: 0, details: [] };

  if (!mailer) {
    result.error = "邮件服务未配置（缺少 QQ_USER / QQ_AUTH_CODE 环境变量）";
    return result;
  }

  let blobs = [];
  try {
    const listed = await store.list({ prefix: "user:" });
    blobs = listed.blobs || [];
  } catch (e) {
    result.error = "枚举用户失败: " + String((e && e.message) || e);
    return result;
  }

  for (const blob of blobs) {
    const username = blob.key.slice("user:".length);
    let user;
    try {
      user = await store.get(blob.key, { type: "json", consistency: "strong" });
    } catch {
      continue;
    }
    if (!user) continue;

    const tKey = `todos:${username}`;
    let todos = [];
    try {
      todos = (await store.get(tKey, { type: "json", consistency: "strong" })) || [];
    } catch {
      continue;
    }

    // ---------------- 先结算「倒计时待办」（与有没有绑邮箱无关） ----------------
    // 这一步是兜底：用户几天不开 App 时，完成记录（热力图/统计/年度总结）
    // 也要落在正确的那一天，所以不依赖用户访问，定时任务主动结算。
    const settled = settleAutoTodos(todos, now);
    if (settled.completed.length) {
      try {
        await store.setJSON(tKey, settled.kept);
        const compKey = `completions:${username}`;
        const existing = (await store.get(compKey, { type: "json", consistency: "strong" })) || [];
        const records = settled.completed.map((c) =>
          makeCompletion(c.todo, c.at, `auto${String(c.at).slice(-6)}${Math.random().toString(36).slice(2, 6)}`)
        );
        await store.setJSON(compKey, appendCompletions(existing, records, MAX_COMPLETIONS));
        todos = settled.kept;
        result.autoSettled = (result.autoSettled || 0) + settled.completed.length;
        result.details.push(
          ...settled.completed.map((c) => ({
            username, todo: c.todo.text, autoSettled: true, at: new Date(c.at).toISOString(),
          }))
        );
      } catch (e) {
        result.details.push({ username, autoSettleError: String((e && e.message) || e) });
        continue;
      }
    }

    // 没绑邮箱就只做结算，不发邮件
    if (!user.email) continue;
    result.scannedUsers++;

    let changed = false;
    for (const todo of todos) {
      result.scannedTodos++;

      const remain = todo.deadline - now;
      const stage = currentStage(remain);
      if (!stage) continue; // 还没到任何提醒阶段

      const sent = sentStages(todo);
      if (sent.includes(stage)) continue; // 这一档已发过

      result.due++;
      const mail = renderEmail({ todo, remain, appUrl, stage });

      if (dryRun) {
        result.details.push({
          username, todo: todo.text, to: user.email, stage, subject: mail.subject, dryRun: true,
        });
        continue;
      }

      try {
        await mailer.sendMail({
          from,
          to: user.email,
          subject: mail.subject,
          text: mail.text,
          html: mail.html,
        });

        // 标记「截至当前阶段」的所有档位为已发：
        // 例如待办直接跳到超时，就把 3d / 1d 一起标记，避免之后补发一串。
        const idx = STAGES.indexOf(stage);
        const mark = new Set(sent);
        for (let i = 0; i <= idx; i++) mark.add(STAGES[i]);
        todo.notifiedStages = STAGES.filter((s) => mark.has(s));
        todo.notifiedStage = stage;
        todo.notifiedAt = now;
        todo.notified = true; // 兼容旧字段与旧版前端

        changed = true;
        result.sent++;
        result.details.push({ username, todo: todo.text, to: user.email, stage, sent: true });
      } catch (e) {
        result.failed++;
        result.details.push({
          username, todo: todo.text, to: user.email, stage, error: String((e && e.message) || e),
        });
      }
    }

    if (changed) {
      try {
        await store.setJSON(tKey, todos);
      } catch (e) {
        result.details.push({ username, saveError: String((e && e.message) || e) });
      }
    }
  }

  return result;
}
