const fs = require('node:fs/promises');
const path = require('node:path');

function isMarkdownFile(filePath) {
  return path.extname(filePath).toLowerCase() === '.md';
}

// 递归扫描目录下的 .md 文件，返回相对路径（POSIX 风格，已排序）
async function scanMarkdownFiles(sourceDir, { recursive = true } = {}) {
  const results = [];

  async function walk(currentDir, relDir) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        if (recursive) {
          await walk(path.join(currentDir, entry.name), relPath);
        }
        continue;
      }

      if (entry.isFile() && isMarkdownFile(entry.name)) {
        results.push(relPath);
      }
    }
  }

  await walk(sourceDir, '');
  return results.sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
}

// 根据源文件相对路径计算输出 PDF 相对路径（保留目录结构）
function buildOutputPath(inputRelPath) {
  const parsed = path.parse(inputRelPath);
  const relDir = parsed.dir ? parsed.dir : '';
  return relDir ? path.posix.join(relDir, `${parsed.name}.pdf`) : `${parsed.name}.pdf`;
}

function safeJoin(rootDir, relPath) {
  const resolvedRoot = path.resolve(rootDir);
  const resolved = path.resolve(resolvedRoot, relPath);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
    const error = new Error(`非法路径：${relPath}`);
    error.statusCode = 400;
    throw error;
  }
  return resolved;
}

// 清洗前端传来的相对路径（文件夹上传场景）：
// 统一分隔符、拒绝绝对路径与 .. 穿越，返回 POSIX 风格安全相对路径
function sanitizeRelPath(rawPath) {
  const normalized = String(rawPath || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .split('/')
    .filter((seg) => seg && seg !== '.' && seg !== '..')
    .join('/');

  if (!normalized || normalized !== String(rawPath || '').replace(/\\/g, '/').split('/').filter((seg) => seg && seg !== '.').join('/')) {
    const error = new Error(`非法文件路径：${rawPath}`);
    error.statusCode = 400;
    throw error;
  }
  return normalized;
}

// 递归列出目录下全部文件（含图片等资源），返回 [{ path, size }]，path 为 POSIX 相对路径
async function scanAllFiles(sourceDir, { limit = 5000 } = {}) {
  const results = [];

  async function walk(currentDir, relDir) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      if (results.length >= limit) return;
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        await walk(path.join(currentDir, entry.name), relPath);
        continue;
      }

      if (entry.isFile()) {
        let size = 0;
        try {
          size = (await fs.stat(path.join(currentDir, entry.name))).size;
        } catch { /* 忽略统计失败 */ }
        results.push({ path: relPath, size });
      }
    }
  }

  await walk(sourceDir, '');
  return results.sort((a, b) => a.path.localeCompare(b.path, 'zh-Hans-CN'));
}

module.exports = {
  buildOutputPath,
  isMarkdownFile,
  safeJoin,
  sanitizeRelPath,
  scanAllFiles,
  scanMarkdownFiles
};
