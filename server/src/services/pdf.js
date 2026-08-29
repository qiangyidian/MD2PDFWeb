const { getBrowser } = require('./browser');
const config = require('../config');

// 渲染并发由 services/scheduler.js 统一调度（多用户消息队列），本模块只负责单次渲染。

// 等待字体与图片加载完成（对应原 Electron 版 waitForAssets）
async function waitForAssets(page) {
  return page.evaluate(`
    (async () => {
      const timeout = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      if (document.fonts && document.fonts.ready) {
        await Promise.race([document.fonts.ready, timeout(5000)]);
      }

      const images = Array.from(document.images || []);
      await Promise.all(images.map((img) => {
        if (img.complete) return Promise.resolve();
        return new Promise((resolve) => {
          const done = () => resolve();
          img.addEventListener('load', done, { once: true });
          img.addEventListener('error', done, { once: true });
          setTimeout(done, 5000);
        });
      }));

      return images
        .filter((img) => !img.complete || img.naturalWidth === 0)
        .map((img) => img.getAttribute('src') || img.src);
    })()
  `);
}

function mmToInches(mm) {
  return mm / 25.4;
}

/**
 * 将完整 HTML 渲染为 PDF Buffer。
 * @param {string} html     renderMarkdownToHtml 的输出
 * @param {object} options  { pageSize: 'A4'|'Letter', marginMm: number, printBackground: boolean }
 */
async function renderHtmlToPdf(html, options) {
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.setContent(html, { waitUntil: 'load', timeout: 60000 });

    let missingImages = [];
    try {
      missingImages = await waitForAssets(page);
    } catch {
      missingImages = [];
    }

    const marginInches = mmToInches(options.marginMm);
    const pdfBuffer = await page.pdf({
      landscape: false,
      printBackground: options.printBackground !== false,
      preferCSSPageSize: true,
      format: options.pageSize === 'Letter' ? 'Letter' : 'A4',
      timeout: Math.min(config.queue.taskTimeoutMs, 90 * 1000),
      margin: {
        top: `${options.marginMm}mm`,
        bottom: `${options.marginMm}mm`,
        left: `${options.marginMm}mm`,
        right: `${options.marginMm}mm`
      }
    });

    return { pdfBuffer, missingImages };
  } finally {
    await page.close().catch(() => {});
  }
}

module.exports = { renderHtmlToPdf, mmToInches };
