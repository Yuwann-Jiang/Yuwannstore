// 本地测试：用一个「假 SMTP 服务器」验证自实现的 SMTP 客户端协议是否正确
// 无需真实邮箱凭据，即可验证握手、认证、投递、报文构造全流程。
//
// 运行：node test-smtp.mjs
import net from "node:net";
import { smtpSend, buildMessage, renderEmail } from "./lib/notify.js";

let pass = 0, fail = 0;
function chk(name, actual, expect) {
  const ok = actual === expect;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}   (实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expect)})`);
  ok ? pass++ : fail++;
}
function chkTrue(name, cond, extra = "") {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${extra ? "   " + extra : ""}`);
  cond ? pass++ : fail++;
}

// ---------------------------------------------------------------------------
// 假 SMTP 服务器
// ---------------------------------------------------------------------------
const received = { commands: [], data: null, authUser: null, authPass: null };

const server = net.createServer((socket) => {
  let buffer = "";
  let inData = false;
  const w = (s) => socket.write(s);

  w("220 fake.example.com ESMTP ready\r\n");

  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");

    if (inData) {
      const end = buffer.indexOf("\r\n.\r\n");
      if (end === -1) return;
      received.data = buffer.slice(0, end);
      buffer = buffer.slice(end + 5);
      inData = false;
      w("250 OK: queued as FAKE123\r\n");
      return;
    }

    let idx;
    while ((idx = buffer.indexOf("\r\n")) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      received.commands.push(line);

      if (line.startsWith("EHLO")) {
        // 多行响应，测试客户端能否正确识别「最终行」
        w("250-fake.example.com hello\r\n250-SIZE 35882577\r\n250-AUTH LOGIN PLAIN\r\n250 OK\r\n");
      } else if (line === "AUTH LOGIN") {
        w("334 VXNlcm5hbWU6\r\n"); // "Username:"
      } else if (received.commands.filter((c) => !c.startsWith("EHLO")).length === 2) {
        received.authUser = Buffer.from(line, "base64").toString("utf8");
        w("334 UGFzc3dvcmQ6\r\n"); // "Password:"
      } else if (line.startsWith("MAIL FROM")) {
        w("250 OK\r\n");
      } else if (line.startsWith("RCPT TO")) {
        w("250 OK\r\n");
      } else if (line === "DATA") {
        inData = true;
        w("354 End data with <CR><LF>.<CR><LF>\r\n");
      } else if (line === "QUIT") {
        w("221 Bye\r\n");
        socket.end();
      } else if (received.authUser && !received.authPass) {
        received.authPass = Buffer.from(line, "base64").toString("utf8");
        w("235 2.7.0 Authentication successful\r\n");
      } else {
        w("250 OK\r\n");
      }
    }
  });
  socket.on("error", () => {});
});

const port = await new Promise((res) => server.listen(0, "127.0.0.1", () => res(server.address().port)));
console.log(`假 SMTP 服务器已启动于 127.0.0.1:${port}\n`);

// ---------------------------------------------------------------------------
// 1. 报文构造测试
// ---------------------------------------------------------------------------
console.log("=== 1. 邮件报文构造 ===");
const todo = { id: "abc", text: "提交周报", deadline: Date.now() + 3 * 3600 * 1000, created: Date.now() };
const mail = renderEmail({ todo, remain: 3 * 3600 * 1000, appUrl: "https://yuwann-todo.netlify.app/" });
chkTrue("生成主题非空", typeof mail.subject === "string" && mail.subject.length > 0, `主题=${mail.subject}`);
chkTrue("主题包含任务名", mail.subject.includes("提交周报"));
chkTrue("生成 HTML 正文", typeof mail.html === "string" && mail.html.includes("提交周报"));
chkTrue("生成纯文本正文", typeof mail.text === "string" && mail.text.includes("提交周报"));

const msg = buildMessage({ from: "a@qq.com", to: "b@qq.com", subject: mail.subject, text: mail.text, html: mail.html });
chkTrue("报文含 From 头", msg.includes("From: "));
chkTrue("报文含 To 头", msg.includes("To: <b@qq.com>"));
chkTrue("报文中文主题已 RFC2047 编码", msg.includes("=?UTF-8?B?"));
chkTrue("报文含 multipart 边界", msg.includes("multipart/alternative"));
chkTrue("所有行均不超过 998 字符", msg.split("\r\n").every((l) => l.length <= 998));

// ---------------------------------------------------------------------------
// 2. SMTP 协议流程测试
// ---------------------------------------------------------------------------
console.log("\n=== 2. SMTP 协议流程（走假服务器）===");
let sendOk = false, sendErr = null;
try {
  await smtpSend({
    host: "127.0.0.1", port, secure: false,
    user: "test@qq.com", pass: "authcode123",
    from: "test@qq.com", to: "dest@qq.com",
    subject: mail.subject, text: mail.text, html: mail.html,
  });
  sendOk = true;
} catch (e) {
  sendErr = e;
}
chkTrue("发送成功", sendOk, sendErr ? "错误: " + sendErr.message : "");
chk("认证用户名正确", received.authUser, "test@qq.com");
chk("认证授权码正确", received.authPass, "authcode123");
chkTrue("发送了 MAIL FROM", received.commands.some((c) => c.startsWith("MAIL FROM:<test@qq.com>")));
chkTrue("发送了 RCPT TO", received.commands.some((c) => c.startsWith("RCPT TO:<dest@qq.com>")));
chkTrue("发送了 QUIT", received.commands.includes("QUIT"));
chkTrue("服务器收到了邮件正文", !!received.data && received.data.length > 0, `正文长度=${received.data ? received.data.length : 0}`);
chkTrue("正文含 base64 编码的 HTML 部分", !!received.data && received.data.includes("Content-Type: text/html; charset=UTF-8"));

// ---------------------------------------------------------------------------
// 3. 错误处理测试
// ---------------------------------------------------------------------------
console.log("\n=== 3. 错误处理 ===");
let errMsg = null;
try {
  await smtpSend({
    host: "127.0.0.1", port: 1, secure: false, // 1 号端口必然连不上
    user: "a", pass: "b", from: "a@qq.com", to: "b@qq.com",
    subject: "x", text: "y", timeoutMs: 3000,
  });
} catch (e) {
  errMsg = e.message;
}
chkTrue("连接失败时抛出清晰错误", !!errMsg && /SMTP/.test(errMsg), errMsg || "");

server.close();
console.log(`\n===== 结果: 通过 ${pass} 项, 失败 ${fail} 项 =====`);
process.exit(fail === 0 ? 0 : 1);
