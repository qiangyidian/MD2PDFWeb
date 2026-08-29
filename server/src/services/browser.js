const puppeteer = require('puppeteer');

// 全局共享一个无头 Chromium 实例（等同原 Electron 版复用窗口的思路）
let browserPromise = null;

function launch() {
  const promise = puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-features=Translate',
      '--font-render-hinting=none'
    ]
  });

  // 崩溃或被杀后允许下次重新拉起
  promise.catch(() => {
    if (browserPromise === promise) browserPromise = null;
  });
  promise.then((browser) => {
    browser.once('disconnected', () => {
      if (browserPromise === promise) browserPromise = null;
    });
  });

  return promise;
}

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = launch();
  }

  try {
    return await browserPromise;
  } catch (error) {
    browserPromise = null;
    throw error;
  }
}

async function closeBrowser() {
  if (!browserPromise) return;
  const browser = await browserPromise.catch(() => null);
  browserPromise = null;
  if (browser) {
    await browser.close().catch(() => {});
  }
}

module.exports = { getBrowser, closeBrowser };
