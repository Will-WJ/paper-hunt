// 筛选层：关键词匹配 + 关注的 PI 识别（含重名消歧）

import { PIS } from './config.js';
import { cleanAuthor } from './utils.js';

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');

/**
 * 把关键词文本编译成正则
 * - 大小写不敏感
 * - 空格 / 连字符 / 下划线可互换（conformational change / conformational-change）
 * - 允许复数（change → changes），两端加词边界，避免 "design" 命中 "designerly"
 */
export function compileKeywords(list) {
  const seen = new Set();
  const out = [];
  const SEP = '[\\s\\-–—_]+';
  for (const raw of list) {
    const kw = String(raw || '').trim();
    if (!kw) continue;
    const key = kw.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const parts = kw.split(/[\s\-–—_]+/).filter(Boolean).map(escapeRe);
    if (!parts.length) continue;
    const body = parts.join(SEP);
    const lead = /^[a-z0-9]/i.test(kw) ? '(?<![a-z0-9])' : '';
    const tail = /[a-z0-9]$/i.test(kw) ? '(?:s|es|ed)?(?![a-z0-9])' : '';
    try {
      out.push({ raw: kw, re: new RegExp(`${lead}${body}${tail}`, 'i') });
    } catch {
      /* 非法关键词跳过 */
    }
  }
  return out;
}

/**
 * 返回命中列表 [{ kw, where: 'title' | 'abstract' | 'both' }]
 */
export function matchKeywords(item, compiled) {
  if (!compiled.length) return [];
  const title = item.title || '';
  const abstract = item.abstract || '';
  const hits = [];
  for (const { raw, re } of compiled) {
    const inTitle = re.test(title);
    const inAbs = re.test(abstract);
    if (inTitle || inAbs) {
      hits.push({ kw: raw, where: inTitle && inAbs ? 'both' : inTitle ? 'title' : 'abstract' });
    }
  }
  return hits;
}

/** 关键词打分：标题命中权重更高 */
export function keywordScore(hits) {
  return hits.reduce((s, h) => s + (h.where === 'both' ? 4 : h.where === 'title' ? 3 : 1), 0);
}

// ---------------- PI 识别 ----------------

const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z\u4e00-\u9fa5\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** bioRxiv：通讯作者是全名，可以直接做全名匹配 */
function matchPreprintCorresponding(item, pi) {
  const raw = String(item.corresponding || '');
  if (!raw) return null;
  const hay = norm(raw);
  // 保留逗号的轻量归一，用于识别「姓, 名」反序
  const light = raw.toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ').trim();
  const first = escapeRe(norm(pi.first));
  const last = escapeRe(norm(pi.last));

  // 正常顺序："Tanja Kortemme"，可能一人独占，也可能 "; " 分隔多人
  const forward = new RegExp(`(^|\\s)${first}\\s+${last}(\\s|$)`);
  // 反序只认严格的「姓, 名」整段格式（如 "Baker, David"），
  // 否则 "Sarah Baker, David Smith" 会被误判成 David Baker
  const reverse = new RegExp(`(?:^|[;,])\\s*${last}\\s*,\\s*${first}\\s*(?:[;,]|$)`, 'i');

  if (!forward.test(hay) && !reverse.test(light)) return null;

  let boosted = false;
  const inst = norm(item.institution);
  if (inst && pi.inst && pi.inst.some((k) => inst.includes(norm(k)))) boosted = true;

  return { name: pi.name, field: pi.field, strength: 'exact', where: item.institution || '', boosted };
}

/** 期刊：作者串只有 "Kortemme T"，只能姓名缩写 + 位置判断 */
function matchJournalAuthors(item, pi) {
  const authors = item.authors || [];
  if (!authors.length) return null;
  const last = escapeRe(pi.last.toLowerCase());
  const init = escapeRe(String(pi.initials || '').toLowerCase().slice(0, 1));
  const re = new RegExp(`(^|[^a-z])${last}\\s+${init}(?:[^a-z]|$)`, 'i');

  for (let i = 0; i < authors.length; i++) {
    if (re.test(` ${authors[i]} `)) {
      const isLastAuthor = i === authors.length - 1;
      // 重名风险高的姓氏，只有压轴作者才敢认
      const strong = isLastAuthor && !pi.ambiguous;
      return {
        name: pi.name,
        field: pi.field,
        strength: isLastAuthor ? (pi.ambiguous ? 'last-ambiguous' : 'last') : 'maybe',
        position: i + 1,
        of: authors.length,
        strong: strong || (isLastAuthor && pi.ambiguous),
      };
    }
  }
  return null;
}

/** 返回该文章命中的 PI 列表（通常 0 或 1 个） */
export function matchPis(item) {
  const hits = [];
  for (const pi of PIS) {
    const hit =
      item.source === 'biorxiv'
        ? matchPreprintCorresponding(item, pi)
        : matchJournalAuthors(item, pi);
    if (hit) hits.push(hit);
  }
  return hits;
}

const STRENGTH_RANK = { exact: 3, last: 2, 'last-ambiguous': 2, maybe: 1 };

export function piRank(piHits) {
  return piHits.reduce((m, h) => Math.max(m, STRENGTH_RANK[h.strength] || 0), 0);
}

/** 给一条文献打上筛选结果与排序权重 */
export function evaluate(item, compiled) {
  const kw = matchKeywords(item, compiled);
  const pis = matchPis(item);
  const score =
    piRank(pis) * 100 + keywordScore(kw) * 10 + (item.source === 'journal' ? 5 : 0);
  return { ...item, kw, pis, score, authorDisplay: (item.authors || []).map(cleanAuthor) };
}

export function sortEvaluated(list) {
  return list.slice().sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const d = String(b.date).localeCompare(String(a.date));
    if (d !== 0) return d;
    return String(a.title).localeCompare(String(b.title));
  });
}
