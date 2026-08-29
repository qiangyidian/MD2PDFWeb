const fs = require('node:fs/promises');
const path = require('node:path');
const AdmZip = require('adm-zip');
const { safeJoin } = require('./fileScanner');
const zipDecoder = require('./zipDecode');
const config = require('../config');

// 解压上传的 zip 到 sourceDir，带路径穿越与 zip 炸弹防护
async function extractZip(zipFilePath, sourceDir) {
  const zip = new AdmZip(zipFilePath, { decoder: zipDecoder });
  const entries = zip.getEntries();
  const limits = config.limits;
  let totalBytes = 0;
  let fileCount = 0;

  for (const entry of entries) {
    if (entry.isDirectory) continue;

    const entryName = entry.entryName.replace(/\\/g, '/');
    if (path.isAbsolute(entryName) || entryName.split('/').includes('..')) {
      const error = new Error(`压缩包内包含非法路径：${entryName}`);
      error.statusCode = 400;
      throw error;
    }

    totalBytes += Number(entry.header.size) || 0;
    if (totalBytes > limits.maxUploadBytes * 3) {
      const error = new Error('压缩包解压后体积过大');
      error.statusCode = 413;
      throw error;
    }

    fileCount += 1;
    if (fileCount > limits.maxFilesPerJob * 20) {
      const error = new Error('压缩包内文件数量过多');
      error.statusCode = 413;
      throw error;
    }

    const targetPath = safeJoin(sourceDir, entryName);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, entry.getData());
  }

  return { entries: fileCount };
}

module.exports = { extractZip };
