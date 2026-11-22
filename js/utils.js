// 通用工具：日期、文本清洗、格式化

export const WEEK_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export function pad2(n) {
  return n < 10 ? `0${n}` : String(n);
}

/** 本地时区的 YYYY-MM-DD */
export function isoDate(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function parseISO(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

export function addDays(iso, n) {
  const d = parseISO(iso);
  d.setDate(d.getDate() + n);
  return isoDate(d);
}

export function weekdayOf(iso) {
  return parseISO(iso).getDay();
}

export function isWeekend(iso) {
  const w = weekdayOf(iso);
  return w === 0 || w === 6;
}

/** bioRxiv 周末基本不更新：默认落到最近的周五 */
export function latestPostingDay(from = new Date()) {
  const iso = isoDate(from);
  const w = weekdayOf(iso);
  if (w === 6) return addDays(iso, -1);
  if (w === 0) return addDays(iso, -2);
  return iso;
}

export function daysBetween(a, b) {
  return Math.round((parseISO(b) - parseISO(a)) / 86400000);
}

/** 11月20日 周四 */
export function cnDate(iso) {
  const d = parseISO(iso);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${WEEK_CN[d.getDay()]}`;
}

/** 11-20 */
export function shortDate(iso) {
  const d = parseISO(iso);
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 相对今天的中文描述 */
export function relDay(iso, today = isoDate()) {
  const diff = daysBetween(iso, today);
  if (diff === 0) return '今天';
  if (diff === 1) return '昨天';
  if (diff === 2) return '前天';
  return cnDate(iso);
}

export function escapeHtml(s = '') {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
  '&apos;': "'", '&nbsp;': ' ', '&ndash;': '–', '&mdash;': '—',
  '&hellip;': '…', '&lsquo;': '‘', '&rsquo;': '’', '&ldquo;': '“', '&rdquo;': '”',
};

/** 去掉摘要里的 HTML 标签与实体 */
export function stripHtml(html = '') {
  let s = String(html)
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|div|h\d|li)>/gi, ' ')
    .replace(/<[^>]+>/g, '');
  s = s.replace(/&[a-zA-Z#0-9]+;/g, (m) => ENTITIES[m] ?? m);
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * bioRxiv 作者格式 "Vogel, I. R." → "Vogel IR"
 * 期刊格式 "Li H" 原样返回
 */
export function cleanAuthor(a = '') {
  const s = String(a).trim().replace(/\./g, '');
  const m = s.match(/^([^,]+),\s*(.+)$/);
  if (m) return `${m[1].trim()} ${m[2].replace(/[\s,]+/g, '')}`.trim();
  return s;
}

/** 返回 { shown: string[], more: number } */
export function authorList(authors = [], max = 4) {
  const list = authors.map(cleanAuthor).filter(Boolean);
  if (list.length <= max) return { shown: list, more: 0 };
  return { shown: list.slice(0, max), more: list.length - max };
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function debounce(fn, wait = 250) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

async function fetchJsonOnce(url, { timeout = 25000, signal } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  const onAbort = () => ctrl.abort();
  if (signal) signal.addEventListener('abort', onAbort);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * 带超时与退避重试的 fetch
 * 只对网络错误 / 429 / 5xx 重试；404 这类确定性错误直接抛出
 */
export async function fetchJson(url, { retries = 1, retryDelay = 700, ...opts } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetchJsonOnce(url, opts);
    } catch (err) {
      lastErr = err;
      if (err.name === 'AbortError' && opts.signal && opts.signal.aborted) throw err;
      const status = err.status || 0;
      const retriable = !status || status === 429 || status >= 500;
      if (!retriable || attempt === retries) throw err;
      // 被限流时退避久一点，别在对方说"慢点"的时候继续猛敲
      const factor = status === 429 ? 4 : attempt + 1;
      await sleep(retryDelay * factor);
    }
  }
  throw lastErr;
}

export function pct(n, d) {
  if (!d) return 0;
  return Math.round((n / d) * 100);
}
