// 筛选层：关键词匹配 + 关注的 PI 识别（含重名消歧与多种姓名写法）

import { DEFAULT_PIS } from './config.js';
import { cleanAuthor } from './utils.js';

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');

/**
 * 归一化人名：去重音、去标点、小写、压空格
 * "Kortemme, T." → "kortemme t"
 */
export function normName(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[.,;:()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 解析人名，兼容文献里的各种写法：
 *   "David Baker" / "Baker, David" / "Baker D" / "D. Baker" / "Van der Berg J"
 * 返回 { first, last }
 */
export function parsePerson(raw) {
  const s = String(raw || '').trim().replace(/\s+/g, ' ');
  if (!s) return null;

  // 逗号分隔一律按「姓, 名」
  if (s.includes(',')) {
    const i = s.indexOf(',');
    const last = s.slice(0, i).trim();
    if (!last) return null;
    return { first: s.slice(i + 1).trim(), last };
  }

  const parts = s.split(' ').filter(Boolean);
  if (parts.length === 1) return { first: '', last: parts[0] };

  // 末尾只有一个字母 → 「姓 缩写」写法，如 "Kortemme T"
  const tail = parts[parts.length - 1].replace(/\./g, '');
  if (tail.length === 1) {
    return { first: tail, last: parts.slice(0, -1).join(' ') };
  }
  return { first: parts.slice(0, -1).join(' '), last: tail };
}

const words = (s) => normName(s).split(' ').filter(Boolean).map(escapeRe);
const phraseRe = (parts) => new RegExp(`(?:^|\\s)${parts.join('\\s+')}(?=\\s|$)`);

/** 为一个具体人名生成匹配规则 */
function personPatterns(person) {
  const out = [];
  const last = words(person.last);
  if (!last.length) return out;

  const first = words(person.first);
  const initial = first.length ? first[0][0] : '';

  // 全名：正序一定认；反序（Lu Peilong）只在短名字里认，
  // 避免 "Sarah Baker, David Smith" 这种多人串被误判成 David Baker
  if (first.length && normName(person.first).length > 1) {
    out.push({ kind: 'phrase', re: phraseRe([...first, ...last]) });
    out.push({ kind: 'phrase', rev: true, re: phraseRe([...last, ...first]) });
  }
  // 姓 + 首字母缩写
  if (initial) {
    out.push({ kind: 'initial', re: phraseRe([...last, initial]) });
    out.push({ kind: 'initial', rev: true, re: phraseRe([initial, ...last]) });
  } else {
    out.push({ kind: 'surname', re: phraseRe(last) });
  }
  return out;
}

/**
 * 预处理 PI 列表：把姓名、别名都展开成匹配规则
 * 每次重算前调用一次，避免逐条文献重复构造正则
 */
export function preparePis(list) {
  return (list || [])
    .filter((p) => p && p.name)
    .map((p) => {
      const aliases = (p.aliases || []).filter((a) => String(a).trim());
      const persons = [parsePerson(p.name), ...aliases.map(parsePerson)].filter(Boolean);
      const patterns = [];
      for (const person of persons) patterns.push(...personPatterns(person));
      return { ...p, inst: (p.inst || []).filter(Boolean), patterns };
    });
}

// ---------------- 关键词 ----------------

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

export function keywordScore(hits) {
  return hits.reduce((s, h) => s + (h.where === 'both' ? 4 : h.where === 'title' ? 3 : 1), 0);
}

// ---------------- PI 识别 ----------------

function instHit(item, pi) {
  const inst = normName(item.institution);
  if (!inst) return false;
  return pi.inst.some((k) => {
    const needle = normName(k);
    return needle && inst.includes(needle);
  });
}

/** bioRxiv：通讯作者字段，多数是全名，也可能是缩写 */
function matchCorresponding(item, pi) {
  const hay = normName(item.corresponding);
  if (!hay) return null;
  // 反序写法只在"像单个人名"的字符串里启用
  const allowReverse = hay.split(' ').length <= 3;

  for (const pat of pi.patterns) {
    if (pat.rev && !allowReverse) continue;
    if (!pat.re.test(hay)) continue;
    const boosted = instHit(item, pi);
    // 全名命中、机构对得上、或姓氏本身不常见 → 认定
    const strong = pat.kind === 'phrase' || boosted || !pi.ambiguous;
    return {
      name: pi.name,
      field: pi.field || '',
      strength: strong ? 'exact' : 'maybe',
      kind: pat.kind,
      boosted,
      where: item.institution || '',
    };
  }
  return null;
}

/** 期刊：作者串只有 "Kortemme T"，只能靠缩写 + 位置 */
function matchAuthors(item, pi) {
  const authors = item.authors || [];
  for (let i = 0; i < authors.length; i++) {
    const hay = normName(authors[i]);
    if (!hay) continue;
    for (const pat of pi.patterns) {
      if (!pat.re.test(hay)) continue;
      const isLast = i === authors.length - 1;
      return {
        name: pi.name,
        field: pi.field || '',
        strength: isLast ? (pi.ambiguous ? 'last-ambiguous' : 'last') : 'maybe',
        kind: pat.kind,
        position: i + 1,
        of: authors.length,
      };
    }
  }
  return null;
}

export function matchPis(item, prepared) {
  const pis = prepared || preparePis(DEFAULT_PIS);
  const hits = [];
  for (const pi of pis) {
    const hit = item.source === 'biorxiv' ? matchCorresponding(item, pi) : matchAuthors(item, pi);
    if (hit) hits.push(hit);
  }
  return hits;
}

const STRENGTH_RANK = { exact: 3, last: 2, 'last-ambiguous': 2, maybe: 1 };

export function piRank(piHits) {
  return piHits.reduce((m, h) => Math.max(m, STRENGTH_RANK[h.strength] || 0), 0);
}

/** 给一条文献打上筛选结果与排序权重 */
export function evaluate(item, compiled, preparedPis) {
  const kw = matchKeywords(item, compiled);
  const pis = matchPis(item, preparedPis);
  const score = piRank(pis) * 100 + keywordScore(kw) * 10 + (item.source === 'journal' ? 5 : 0);
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
