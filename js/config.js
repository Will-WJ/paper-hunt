// 全局配置：数据源、期刊、关注的 PI、默认关键词
// 修改这里会同时影响抓取范围与筛选逻辑

export const APP = {
  name: '文献雷达',
  subtitle: '蛋白设计每日文献',
  version: '1.0.0',
};

// ---------- 数据源 ----------
export const API = {
  biorxiv: 'https://api.biorxiv.org/details/biorxiv',
  europepmc: 'https://www.ebi.ac.uk/europepmc/webservices/rest/search',
};

// ---------- 五大刊 ----------
// match: 用于把 Europe PMC 返回的刊名归一到标准名称
export const JOURNALS = [
  { key: 'nature', label: 'Nature', short: 'N', match: /^nature$/i, color: '#c0392b' },
  { key: 'science', label: 'Science', short: 'S', match: /^science(\s*\(|$)/i, color: '#2c5aa0' },
  { key: 'cell', label: 'Cell', short: 'C', match: /^cell$/i, color: '#1f7a5c' },
  { key: 'nmeth', label: 'Nature Methods', short: 'NM', match: /^nature methods/i, color: '#7d4b9c' },
  { key: 'nbt', label: 'Nature Biotechnology', short: 'NB', match: /^nature biotechnology/i, color: '#b56a12' },
];

export function canonicalJournal(title = '') {
  const t = String(title).trim();
  for (const j of JOURNALS) if (j.match.test(t)) return j;
  return null;
}

// ---------- 关注的通讯作者 ----------
// first/last 为全名匹配（bioRxiv 提供通讯作者全名）
// initials 用于期刊作者串（Europe PMC 只给 "Kortemme T" 这种缩写）
// inst 为机构佐证词，用于给 "David Baker" 这类重名加可信度
export const DEFAULT_PIS = [
  {
    name: 'Bruno Correa',
    first: 'bruno',
    last: 'correa',
    initials: 'B',
    inst: ['institute for protein design', 'washington', 'hhmi', 'howard hughes'],
    field: 'de novo binder / 蛋白设计',
  },
  {
    name: 'Tanja Kortemme',
    first: 'tanja',
    last: 'kortemme',
    initials: 'T',
    inst: ['ucsf', 'california, san francisco', 'bioengineering'],
    field: '计算蛋白设计 / 构象变化',
  },
  {
    name: 'David Baker',
    first: 'david',
    last: 'baker',
    initials: 'D',
    inst: ['institute for protein design', 'university of washington', 'hhmi'],
    field: 'de novo 蛋白设计',
    ambiguous: true,
  },
  {
    name: 'Peilong Lu',
    first: 'peilong',
    last: 'lu',
    initials: 'P',
    inst: ['westlake', '西湖大学'],
    field: 'de novo 蛋白设计 / 结构生物学',
    ambiguous: true,
  },
  {
    name: 'Longxing Cao',
    first: 'longxing',
    last: 'cao',
    initials: 'L',
    inst: ['shanghaitech', 'shanghai tech', '上海科技大学'],
    field: 'de novo 蛋白设计 / 抗体',
    ambiguous: true,
  },
];

// ---------- 默认关键词 ----------
// 每行一个；匹配标题与摘要，不区分大小写，允许连字符/空格互换
// 兼容旧引用
export const PIS = DEFAULT_PIS;

export const DEFAULT_KEYWORDS = [
  'protein design',
  'de novo protein design',
  'de novo design',
  'de novo protein',
  'sequence design',
  'computational design',
  'conformational change',
  'conformation change',
  'binder design',
  'enzyme design',
  'antibody design',
  'protein backbone',
  'RFdiffusion',
  'ProteinMPNN',
  'protein engineering',
  'de novo enzyme',
];

// ---------- 缓存策略 ----------
export const CACHE_TTL = {
  biorxivPast: Infinity,          // 历史日期数据不再变，永久缓存
  biorxivToday: 20 * 60 * 1000,   // 当天数据 20 分钟后过期
  journals: 2 * 60 * 60 * 1000,  // 期刊一天只更新几次，缓存久一点，避免每次都等冷查询
};

export const LS_KEYS = {
  keywords: 'ph.keywords',
  read: 'ph.read',
  stars: 'ph.stars',
  pis: 'ph.pis',
  prefs: 'ph.prefs',
};
