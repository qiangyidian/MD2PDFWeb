const iconv = require('iconv-lite');

// zip 条目文件名解码器：
// 现代压缩包（UTF-8 标志位）是严格 UTF-8；Windows 资源管理器等老式工具
// 打包的中文名多为 GBK 且不带标志位。这里用「严格 UTF-8 优先，失败回退 GBK」，
// 严格校验通过 TextDecoder(fatal) 实现，避免 Buffer.toString 的静默替换符。
const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

module.exports = {
  efs: false,
  encode: (data) => Buffer.from(String(data), 'utf8'),
  decode: (data) => {
    if (!Buffer.isBuffer(data)) data = Buffer.from(data);
    try {
      return strictUtf8.decode(data);
    } catch {
      return iconv.decode(data, 'gbk');
    }
  }
};
