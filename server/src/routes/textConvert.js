const express = require('express');
const rateLimit = require('express-rate-limit');
const path = require('node:path');

const { renderMarkdownToHtml } = require('../services/renderer');
const { renderHtmlToPdf } = require('../services/pdf');
const { normalizeOptions } = require('../services/jobManager');
const scheduler = require('../services/scheduler');

const router = express.Router();

const textLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: '转换过于频繁，请稍后再试。' }
});

// 单篇 Markdown 文本直接转 PDF（即时下载，不落盘）
router.post('/', textLimiter, async (req, res, next) => {
  try {
    const markdown = String((req.body && req.body.markdown) || '');
    if (!markdown.trim()) {
      return res.status(400).json({ error: 'Markdown 内容不能为空' });
    }

    const rawName = String((req.body && req.body.filename) || 'document');
    const safeName = path.basename(rawName).replace(/[\\/:*?"<>|]/g, '_') || 'document';
    const options = normalizeOptions((req.body && req.body.options) || {});

    const html = renderMarkdownToHtml({ markdown, title: safeName, baseUrl: null, options });
    // 交互式请求走高优先级通道，插队于批量任务（并发仍由调度器统一控制）
    const { pdfBuffer } = await scheduler.submitOne(() => renderHtmlToPdf(html, options));

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', pdfBuffer.length);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(`${safeName}.pdf`)}"; filename*=UTF-8''${encodeURIComponent(`${safeName}.pdf`)}`
    );
    res.end(pdfBuffer);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
