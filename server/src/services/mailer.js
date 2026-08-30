const tls = require('node:tls');
const crypto = require('node:crypto');

const config = require('../config');

/**
 * 零依赖 SMTP 客户端（SMTPS，端口 465）
 *
 * 移植自 SQL2ER 的 mail_service.py（smtplib.SMTP_SSL），适配 QQ 邮箱：
 * - 直接 TLS socket（465 隐式 SSL，QQ 邮箱不支持 STARTTLS 升级的 587）
 * - AUTH LOGIN（QQ 授权码场景，base64 编码用户名/授权码）
 * - 邮件正文逐行点填充（RFC 5321 4.5.2：以 . 开头的行前补点，防止正文注入提前终结邮件）
 * - 中文标题 RFC 2047 B 编码
 *
 * 安全设计：授权码只经环境变量注入，不出现在日志与任何响应中；
 * 发送失败抛统一错误（不回显 SMTP 服务器细节，避免探测内部信息）。
 */

class MailError extends Error {}

// 读取一行（CRLF 结尾）的承诺封装
function readReply(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new MailError('邮件服务器响应超时'));
    }, timeoutMs);

    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      // 多行回复格式 "250-xxx" 表示还有后续行，"250 xxx" 为最后一行
      const lines = buffer.split('\r\n');
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (/^\d{3} /.test(line)) {
          cleanup();
          resolve({ code: Number(line.slice(0, 3)), text: line });
          return;
        }
      }
    };
    const onError = (error) => {
      cleanup();
      reject(new MailError(`邮件服务器连接失败：${error.message}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
    };

    socket.on('data', onData);
    socket.on('error', onError);
  });
}

function sendCommand(socket, cmd) {
  return new Promise((resolve, reject) => {
    socket.write(`${cmd}\r\n`, (error) => {
      if (error) reject(new MailError('邮件服务器写入失败'));
      else resolve();
    });
  });
}

function b64(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

// RFC 2047：非 ASCII 标题用 B 编码
function encodeHeader(text) {
  if (/^[\x20-\x7e]*$/.test(text)) return text;
  return `=?UTF-8?B?${b64(text)}?=`;
}

// 邮件正文里的点填充（RFC 5321 4.5.2 transparency）
function dotStuff(body) {
  return body.replace(/\r?\n/g, '\r\n').replace(/(^|\r\n)\./g, '$1..');
}

/**
 * 发送纯文本邮件（同步等待 SMTP 全流程完成后 resolve）
 * @param {string} to       收件人
 * @param {string} subject  标题
 * @param {string} body     纯文本正文
 */
async function sendMail(to, subject, body) {
  const mail = config.mail;
  if (!mail.enabled) throw new MailError('邮件服务未启用');
  if (!mail.host || !mail.username || !mail.password) {
    throw new MailError('邮件服务未配置完整');
  }

  const socket = tls.connect({
    host: mail.host,
    port: mail.port,
    timeout: 15000,
    rejectUnauthorized: true // 校验证书，防中间人
  });

  socket.setEncoding('utf8');

  const step = async (cmd, expectCode) => {
    if (cmd !== null) await sendCommand(socket, cmd);
    const reply = await readReply(socket, 15000);
    const ok = Array.isArray(expectCode) ? expectCode.includes(reply.code) : reply.code === expectCode;
    if (!ok) {
      throw new MailError(`邮件服务器拒绝了请求（${reply.code}）`);
    }
    return reply;
  };

  try {
    await new Promise((resolve, reject) => {
      socket.once('secureConnect', resolve);
      socket.once('error', reject);
    });

    await step(null, 220);                            // 服务器问候
    await step(`EHLO md2pdf.local`, [250]);           // 能力协商（QQ 回单行 250）
    await step('AUTH LOGIN', 334);                    // 要求凭据
    await step(b64(mail.username), 334);
    await step(b64(mail.password), [235, 535]);
    await step(`MAIL FROM:<${mail.from || mail.username}>`, 250);
    await step(`RCPT TO:<${to}>`, [250, 251]);
    await step('DATA', 354);

    const headers = [
      `From: MD2PDF Web <${mail.from || mail.username}>`,
      `To: <${to}>`,
      `Subject: ${encodeHeader(subject)}`,
      'MIME-Version: 1.0',
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${crypto.randomUUID()}@md2pdf.local>`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      ''
    ].join('\r\n');

    // base64 编码正文：避免 8bit 传输被中间网关改写，也天然规避点填充问题
    const encoded = b64(body.replace(/\r?\n/g, '\r\n')).replace(/(.{76})/g, '$1\r\n');
    await socket.write(`${headers}\r\n${encoded}\r\n.\r\n`);
    await readReply(socket, 15000).then((reply) => {
      if (reply.code !== 250) throw new MailError('邮件被服务器拒绝（DATA 阶段）');
    });

    await step('QUIT', 221);
  } finally {
    socket.destroy();
  }
}

async function sendVerificationEmail(to, code, purpose) {
  const action = purpose === 'register' ? '注册' : '登录';
  const body = [
    '你好，',
    '',
    `你正在进行 MD2PDF Web ${action}验证。`,
    `本次验证码是：${code}`,
    `验证码 ${Math.floor(config.mail.verificationCodeTtlSeconds / 60)} 分钟内有效，请勿泄露给他人。`,
    '',
    '如果这不是你的操作，请忽略这封邮件。'
  ].join('\r\n');

  await sendMail(to, `MD2PDF 邮箱验证码（${action}）`, body);
}

module.exports = { MailError, sendMail, sendVerificationEmail };
