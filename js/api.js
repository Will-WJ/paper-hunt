// 数据层：bioRxiv 预印本 + Europe PMC 五大刊
// 两个接口都返回 Access-Control-Allow-Origin: *，所以纯前端即可直连，无需自建后端

import { API, CACHE_TTL, canonicalJournal } from './config.js';
import { stripHtml, fetchJson, isoDate } from './utils.js';
import { cacheGetFresh, cacheSet } from './store.js';

// ---------------- bioRxiv ----------------

function normPreprint(r) {
  const doi = String(r.doi || '').trim();
  const version = String(r.version || '1');
  return {
    id: `bx:${doi}`,
    source: 'biorxiv',
    doi,
    title: stripHtml(r.title || ''),
    abstract: stripHtml(r.abstract || ''),
    authors: String(r.authors || '')
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean),
    corresponding: String(r.author_corresponding || '').trim(),
    institution: String(r.author_corresponding_institution || '').trim(),
    date: String(r.date || '').trim(),
    version,
    type: String(r.type || '').trim(),
    category: String(r.category || '').trim(),
    published: String(r.published || '').trim(),
    url: doi ? `https://doi.org/${doi}` : '',
  };
}

function dedupe(xs) {
  const byDoi = new Map();
  for (const x of xs) {
    const key = x.doi || x.id;
    const prev = byDoi.get(key);
    if (!prev || Number(x.version || 0) > Number(prev.version || 0)) byDoi.set(key, x);
  }
  return [...byDoi.values()];
}

/**
 * 拉取某一天（本地时区 YYYY-MM-DD）的全部 bioRxiv 预印本
 * API 每页 30 条：先取第一页拿到总数，其余页并发抓，避免串行等 9 次往返
 */
export async function fetchBiorxivDay(dateStr, { signal, onProgress, force } = {}) {
  const isToday = dateStr === isoDate();
  const ttl = isToday ? CACHE_TTL.biorxivToday : CACHE_TTL.biorxivPast;
  const cacheKey = `bx:${dateStr}`;
  const cached = force ? null : await cacheGetFresh(cacheKey, ttl);
  if (cached) return cached;

  const pageUrl = (cursor) => `${API.biorxiv}/${dateStr}/${dateStr}/${cursor}`;
  const out = [];

  let first;
  try {
    first = await fetchJson(pageUrl(0), { signal });
  } catch (err) {
    if (/HTTP 404/.test(String(err.message))) {
      await cacheSet(cacheKey, []);
      return [];
    }
    throw err;
  }

  const total = Number(((first.messages && first.messages[0]) || {}).total ?? 0);
  const page1 = first.collection || [];
  if (!page1.length) {
    await cacheSet(cacheKey, []);
    return [];
  }
  out.push(...page1.map(normPreprint));
  if (onProgress) onProgress({ loaded: out.length, total });

  const step = page1.length;
  const cursors = [];
  for (let c = step; c < total; c += step) cursors.push(c);

  // 并发 4 个请求足够快，也不至于把接口惹毛
  const CONCURRENCY = 4;
  let failed = 0;

  async function worker() {
    while (cursors.length) {
      const cursor = cursors.shift();
      let data;
      try {
        data = await fetchJson(pageUrl(cursor), { signal });
      } catch (err) {
        failed += 1;
        continue;
      }
      const col = data.collection || [];
      if (col.length) out.push(...col.map(normPreprint));
      if (onProgress) onProgress({ loaded: out.length, total });
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, cursors.length) }, worker));

  const items = dedupe(out);
  // 有缺页就不写缓存，下次打开还能补全
  if (!failed) await cacheSet(cacheKey, items);
  return items;
}

// ---------------- Europe PMC ----------------

function normArticle(r, journalMeta) {
  const doi = String(r.doi || '').trim();
  const pmid = String(r.pmid || '').trim();
  const types = (r.pubTypeList && r.pubTypeList.pubType) || [];
  return {
    id: `ep:${r.id || doi || pmid}`,
    source: 'journal',
    doi,
    pmid,
    title: stripHtml(r.title || '').replace(/\.$/, ''),
    abstract: stripHtml(r.abstractText || ''),
    authors: String(r.authorString || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    journalKey: journalMeta ? journalMeta.key : 'other',
    journal: journalMeta ? journalMeta.label : String(r.journalTitle || ''),
    date: String(r.firstPublicationDate || r.electronicPublicationDate || '').trim(),
    pubTypes: Array.isArray(types) ? types : [types].filter(Boolean),
    url: doi
      ? `https://doi.org/${doi}`
      : pmid
      ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`
      : '',
  };
}

/**
 * 拉取指定日期区间的五大刊文章
 * 按刊并行查询：Europe PMC 对 "5 个刊 OR 在一起" 的大查询响应很慢（单次 20s+），
 * 拆成 5 个独立请求并发，整体耗时约等于最慢的那一个刊
 * @param {string} from 起始日期 YYYY-MM-DD
 * @param {string} to   结束日期 YYYY-MM-DD
 * @param {Array<{key:string,label:string}>} journals 要检索的期刊
 */
export async function fetchJournals(from, to, journals, { signal, onProgress, onJournal, force } = {}) {
  const cacheKey = `ep:${from}:${to}:${journals.map((j) => j.key).join(',')}`;
  const cached = force ? null : await cacheGetFresh(cacheKey, CACHE_TTL.journals);
  if (cached) return { items: cached, failed: 0 };

  let done = 0;
  const report = () => onProgress && onProgress({ done, total: journals.length });

  async function fetchOne(journal) {
    const query = `JOURNAL:"${journal.label}" AND (FIRST_PDATE:[${from} TO ${to}])`;
    const out = [];
    let cursor = '*';
    for (let guard = 0; guard < 12; guard++) {
      const params = new URLSearchParams({
        query,
        format: 'json',
        pageSize: '100',
        resultType: 'core',
        cursorMark: cursor,
      });
      const data = await fetchJson(`${API.europepmc}?${params}`, {
        signal,
        timeout: 45000,
        retries: 2,
        retryDelay: 900,
      });
      const results = (data.resultList && data.resultList.result) || [];
      if (!results.length) break;
      for (const r of results) {
        const meta = canonicalJournal(
          r.journalTitle || (r.journalInfo && r.journalInfo.journal && r.journalInfo.journal.title) || ''
        );
        if (!meta) continue; // 防止串入子刊
        out.push(normArticle(r, meta));
      }
      const next = data.nextCursorMark;
      if (!next || next === cursor) break;
      cursor = next;
      if (out.length >= Number(data.hitCount ?? 0)) break;
    }
    return out;
  }

  // 并发 5：每个刊只发 1 个请求，偶发的 500 由 retries 兜住
  const queue = journals.slice();
  const collected = [];
  let failed = 0;

  async function worker() {
    while (queue.length) {
      const journal = queue.shift();
      try {
        const got = await fetchOne(journal);
        collected.push(...got);
        if (onJournal && got.length) onJournal(journal, got);
      } catch (err) {
        if (signal && signal.aborted) throw err;
        failed += 1;
      } finally {
        done += 1;
        report();
      }
    }
  }

  await Promise.allSettled(Array.from({ length: Math.min(5, journals.length) }, worker));

  // 全部失败才抛错；部分失败先给已拿到的数据，并把失败数报给上层
  if (!collected.length && failed) throw new Error('期刊接口暂时不可用，请稍后重试');

  collected.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  if (!failed) await cacheSet(cacheKey, collected);
  return { items: collected, failed };
}

/** 判断是否是编辑部/新闻类条目，用于"只看研究论文" */
const NON_RESEARCH = /editorial|comment|news|erratum|retraction|correction|biography|interview|congress|letter to the editor|published erratum|retracted/i;

export function isResearch(item) {
  const types = item.pubTypes || [];
  if (!types.length) return true;
  return !types.some((t) => NON_RESEARCH.test(String(t)));
}
