/**
 * 文档内相对路径图片的引用收集与重写。
 *
 * 安全边界由后端 `authorize_document_assets` 把关：前端只负责**挑选**
 * 候选引用、拿到放行结果后把 `<img src>` 改写成资产协议 URL。任何判定
 * （是否相对、是否越界、是否普通文件）都不在前端做。
 *
 * 原始相对路径必须保留在 `data-src` 上：编辑模式回写与"复制图片地址"
 * 都需要它，改写后的 asset URL 不是文档的一部分。
 */

const ASSET_ATTR = 'data-asset-src';

/**
 * 只挑选相对路径候选。含协议（`http:`/`data:`/`file:`）、绝对路径与
 * 锚点一律不挑——它们要么由浏览器直接处理，要么本就不该走资产通道。
 */
export function collectRelativeImageReferences(html) {
  const references = new Set();
  const pattern = /<img\b[^>]*>/gi;
  let match;

  while ((match = pattern.exec(html)) !== null) {
    const src = extractAttribute(match[0], 'src');
    if (src && isRelativeReference(src)) {
      references.add(decodeHtmlEntities(src));
    }
  }

  return [...references];
}

function extractAttribute(tag, name) {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i'))
    ?? tag.match(new RegExp(`\\b${name}\\s*=\\s*'([^']*)'`, 'i'));
  return match ? match[1].trim() : '';
}

function isRelativeReference(value) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed || trimmed.startsWith('#')) return false;
  if (trimmed.startsWith('/') || trimmed.startsWith('\\')) return false;
  if (trimmed.includes(':')) return false;
  return true;
}

function decodeHtmlEntities(value) {
  return String(value)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/**
 * 把后端返回的放行路径按原相对引用分组，供 DOM 重写时查表。
 * 键与值都是**绝对路径**：后端返回的是 canonicalize 后的结果，与前端
 * 手里只有相对路径的事实无法直接匹配，因此由后端按原引用返回更可靠。
 * 这里改为「绝对路径集合」，重写时按规范化的候选绝对路径匹配。
 */
export function buildAssetLookup(allowedPaths) {
  return new Set((allowedPaths ?? []).map(normalizeReference));
}

/**
 * 规范化绝对路径用于前后端比对。
 *
 * 后端返回的是 `fs::canonicalize` 的结果，Windows 上带 `\\?\` 扩展长度
 * 前缀且使用反斜杠；前端拼出的是正斜杠形式。两侧必须归一到同一形态，
 * 否则放行集合永远匹配不上（表现为图片一个都不显示）。
 */
function normalizeReference(reference) {
  return String(reference ?? '')
    .trim()
    .replace(/^\\\\\?\\/, '')
    .replaceAll('\\', '/');
}

/**
 * 在渲染后的 DOM 上重写图片地址。只改写后端已放行的引用，其余保持
 * 原样交给浏览器处理——失败关闭。
 *
 * 必须在 HTML 写入正文状态**之前**调用：首帧 `<img>` 请求与白名单写入
 * 存在竞态，首帧失败不会自动重试。
 *
 * 返回实际改写的数量；没有可用的资产协议时（浏览器预览）返回 0。
 */
export function rewriteImageSources(root, allowedPaths, documentPath) {
  if (!root || typeof root.querySelectorAll !== 'function') return 0;

  const convert = resolveAssetUrlConverter();
  if (!convert) return 0;

  const allowed = buildAssetLookup(allowedPaths);
  let rewritten = 0;

  for (const image of root.querySelectorAll('img[src]')) {
    const original = image.getAttribute('src');
    if (!original || !isRelativeReference(original)) continue;

    const absolute = resolveAgainst(original, documentPath);
    if (absolute === null || !allowed.has(absolute)) continue;

    image.setAttribute(ASSET_ATTR, original);
    image.setAttribute('src', convert(absolute));
    image.setAttribute('loading', 'lazy');
    rewritten += 1;
  }

  return rewritten;
}

/**
 * 把相对引用按**文档所在目录**拼成规范化的绝对路径（统一正斜杠）。
 *
 * `documentPath` 是文档文件的完整路径，与后端 `resolve_asset` 的解析基准
 * 保持一致——两边必须同基准，否则放行集合匹配不上。
 *
 * 纯字符串运算；越界与符号链接的权威判定在后端（canonicalize + 前缀比较）。
 */
export function resolveAgainst(reference, documentPath) {
  if (!documentPath) return null;
  const base = normalizeReference(documentPath).replace(/\/+$/, '').split('/');
  // 末段是文件名：引用相对**所在目录**，不是相对文件本身。
  base.pop();

  for (const segment of normalizeReference(reference).split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (base.length === 0) return null;
      base.pop();
      continue;
    }
    base.push(segment);
  }

  return base.join('/');
}

function resolveAssetUrlConverter() {
  const convert = globalThis.__TAURI__?.core?.convertFileSrc;
  return typeof convert === 'function' ? convert : null;
}

/**
 * 保留 `data-asset-src` 上的原值；编辑回写与复制地址都读它，
 * 而不是读已改写的 asset URL。
 */
export function readOriginalAssetSource(image) {
  return image?.getAttribute?.(ASSET_ATTR) ?? image?.getAttribute?.('src') ?? '';
}