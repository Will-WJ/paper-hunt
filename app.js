// 应用入口：状态、渲染、交互

import { APP, JOURNALS, PIS, DEFAULT_KEYWORDS, LS_KEYS } from './js/config.js';
import {
  latestPostingDay, isoDate, addDays, cnDate, relDay, shortDate,
  escapeHtml, authorList, debounce, daysBetween,
} from './js/utils.js';
import { fetchBiorxivDay, fetchJournals, isResearch } from './js/api.js';
import { compileKeywords, evaluate, sortEvaluated } from './js/match.js';
import { stateGet, stateSet, cacheClear } from './js/store.js';

const esc = escapeHtml;
const $ = (sel, root = document) => root.querySelector(sel);

// ---------------- 状态 ----------------

const state = {
  tab: 'biorxiv',
  bx: { date: latestPostingDay(), raw: [], items: [], loading: false, error: null, progress: '' },
  jr: { days: 7, from: '', to: '', raw: [], items: [], loading: false, error: null, progress: '' },
  read: stateGet(LS_KEYS.read, {}) || {},
  stars: stateGet(LS_KEYS.stars, {}) || {},
  keywords: stateGet(LS_KEYS.keywords, DEFAULT_KEYWORDS.join('\n')),
  filter: { biorxiv: 'hit', journals: 'hit' },
  researchOnly: true,
  query: '',
  expanded: new Set(),
  compiled: [],
};

const persist = {
  read: debounce(() => stateSet(LS_KEYS.read, state.read), 400),
  stars: debounce(() => stateSet(LS_KEYS.stars, state.stars), 400),
  keywords: debounce(() => stateSet(LS_KEYS.keywords, state.keywords), 400),
};

// ---------------- 数据加载 ----------------

function setProgress(text) {
  const el = $('#prog');
  if (el) el.textContent = text;
  else {
    const st = currentStore();
    if (st) st.progress = text;
  }
}

function currentStore() {
  if (state.tab === 'biorxiv') return state.bx;
  if (state.tab === 'journals') return state.jr;
  return null;
}

async function loadBiorxiv({ force = false, allowFallback = false } = {}) {
  const st = state.bx;
  st.loading = true;
  st.error = null;
  st.raw = [];
  render();

  const appendPage = (got) => {
    const seen = new Set(st.raw.map((x) => x.doi || x.id));
    const fresh = got.filter((x) => !seen.has(x.doi || x.id));
    if (!fresh.length) return;
    st.raw.push(...fresh);
    applyEval();
    render();
  };

  try {
    let day = st.date;
    let raw = [];
    const maxTries = allowFallback ? 4 : 1;
    for (let i = 0; i < maxTries; i++) {
      if (i > 0) st.raw = [];
      raw = await fetchBiorxivDay(day, {
        force: force && i === 0,
        onPage: appendPage,
        onProgress: (p) => setProgress(`正在抓取 ${p.loaded}/${p.total || '?'} 篇`),
      });
      if (raw.length) break;
      const prev = addDays(day, -1);
      if (prev < addDays(isoDate(), -4)) break;
      day = prev;
    }
    if (day !== st.date) {
      st.date = day;
      toast(`这天还没有更新，已切到 ${relDay(day)}`);
    }
    st.raw = raw;
  } catch (err) {
    st.error = err && err.message ? err.message : '加载失败';
  }
  st.loading = false;
  applyEval();
  render();
}

async function loadJournals({ force = false } = {}) {
  const st = state.jr;
  st.loading = true;
  st.error = null;
  render();

  const to = isoDate();
  const from = addDays(to, -(st.days - 1));
  st.from = from;
  st.to = to;
  st.raw = [];

  try {
    const res = await fetchJournals(from, to, JOURNALS, {
      force,
      onProgress: (p) => setProgress(`正在抓取 ${p.done}/${p.total} 个期刊`),
      // 哪个刊先回来就先渲染，不用等最慢的那个
      onJournal: (_journal, got) => {
        const seen = new Set(st.raw.map((x) => x.id));
        st.raw.push(...got.filter((x) => !seen.has(x.id)));
        applyEval();
        render();
      },
    });
    st.partial = res.failed || 0;
    if (res.items.length) st.raw = res.items;
    if (res.failed) toast(`${res.failed} 个期刊没抓到，稍后点刷新可补上`);
  } catch (err) {
    st.error = err && err.message ? err.message : '加载失败';
  }
  st.loading = false;
  applyEval();
  render();
}

function applyEval() {
  state.compiled = compileKeywords(String(state.keywords).split('\n'));
  state.bx.items = sortEvaluated(state.bx.raw.map((x) => evaluate(x, state.compiled)));
  state.jr.items = sortEvaluated(state.jr.raw.map((x) => evaluate(x, state.compiled)));
}

// ---------------- 过滤 ----------------

function hitsOf(list) {
  return list.filter((x) => x.kw.length || x.pis.length);
}

function piHitsOf(list) {
  return list.filter((x) => x.pis.length);
}

function filterList(list, mode) {
  if (mode === 'hit') return hitsOf(list);
  if (mode === 'pi') return piHitsOf(list);
  return list;
}

function visibleList() {
  const isBx = state.tab === 'biorxiv';
  const st = isBx ? state.bx : state.jr;
  let list = filterList(st.items, state.filter[state.tab]);
  if (!isBx && state.researchOnly) list = list.filter(isResearch);

  const q = state.query.trim().toLowerCase();
  if (q) {
    list = list.filter((x) => {
      const hay = `${x.title} ${(x.authors || []).join(' ')} ${x.journal || ''} ${x.corresponding || ''}`.toLowerCase();
      return hay.includes(q);
    });
  }
  return list;
}

// ---------------- 渲染 ----------------

function render() {
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === state.tab));
  $('#btn-refresh').classList.toggle('spin', state.bx.loading || state.jr.loading);
  syncUrl();
  renderSubbar();
  renderContent();
}

function chip({ label, count, on, act, data = '' }) {
  const cls = `chip${on ? ' on' : ''}${act ? '' : ' static'}`;
  const n = count === undefined || count === null ? '' : `<span class="n">${count}</span>`;
  const attrs = act ? `data-chip="${act}" ${data}` : '';
  return `<button class="${cls}" ${attrs}>${label}${n}</button>`;
}

function renderSubbar() {
  const bar = $('#subbar');
  if (state.tab === 'biorxiv') {
    const st = state.bx;
    const total = st.items.length;
    const hits = hitsOf(st.items).length;
    const pis = piHitsOf(st.items).length;
    bar.innerHTML = [
      chip({ label: `${shortDate(st.date)} ${cnDate(st.date).split(' ')[1]}`, act: 'date' }),
      chip({ label: '今天', act: 'today', on: st.date === isoDate() }),
      chip({ label: '命中', count: hits, act: 'f-hit', on: state.filter.biorxiv === 'hit' }),
      chip({ label: '★ 关注', count: pis, act: 'f-pi', on: state.filter.biorxiv === 'pi' }),
      chip({ label: '全部', count: total, act: 'f-all', on: state.filter.biorxiv === 'all' }),
    ].join('');
  } else if (state.tab === 'journals') {
    const st = state.jr;
    const total = st.items.length;
    const research = st.items.filter(isResearch).length;
    const hits = (state.researchOnly ? hitsOf(st.items.filter(isResearch)) : hitsOf(st.items)).length;
    bar.innerHTML = [
      chip({ label: '7天', act: 'r-7', on: st.days === 7 }),
      chip({ label: '14天', act: 'r-14', on: st.days === 14 }),
      chip({ label: '30天', act: 'r-30', on: st.days === 30 }),
      chip({ label: '命中', count: hits, act: 'f-hit', on: state.filter.journals === 'hit' }),
      chip({ label: '全部', count: state.researchOnly ? research : total, act: 'f-all', on: state.filter.journals === 'all' }),
      chip({ label: '只研究论文', act: 'research', on: state.researchOnly }),
    ].join('');
  } else {
    const n = Object.keys(state.stars).length;
    bar.innerHTML = chip({ label: '已收藏', count: n, act: '', on: false });
  }
}

const TYPE_CN = [
  [/retract/i, '撤稿'],
  [/erratum|correction/i, '勘误'],
  [/editorial/i, '社论'],
  [/comment/i, '评论'],
  [/news/i, '新闻'],
  [/review/i, '综述'],
  [/letter/i, '通讯'],
];

function typeLabel(pubTypes = []) {
  for (const [re, label] of TYPE_CN) {
    if (pubTypes.some((t) => re.test(String(t)))) return label;
  }
  return '';
}

function badgesHtml(it) {
  const out = [];
  const pi = it.pis[0];
  if (it.source === 'journal') {
    out.push(`<span class="badge badge-j">${esc(it.journal)}</span>`);
  }
  if (pi) {
    if (pi.strength === 'exact') {
      out.push(`<span class="badge badge-pi">★ ${esc(pi.name)}</span>`);
    } else if (pi.strength === 'last') {
      out.push(`<span class="badge badge-pi">★ ${esc(pi.name)}</span>`);
    } else if (pi.strength === 'last-ambiguous') {
      out.push(`<span class="badge badge-pi">★ ${esc(pi.name)}<span style="opacity:.55">·压轴</span></span>`);
    } else {
      out.push(`<span class="badge badge-pi-weak">可能 · ${esc(pi.name)}</span>`);
    }
  }
  for (const k of it.kw.slice(0, 2)) {
    out.push(`<span class="badge badge-kw">${esc(k.kw)}</span>`);
  }
  if (!out.length && it.category) {
    out.push(`<span class="badge badge-type">${esc(it.category)}</span>`);
  }
  return out.join('');
}

function cardHtml(it) {
  const isRead = !!state.read[it.id];
  const starred = !!state.stars[it.id];
  const isPi = it.pis.length > 0;
  const isOpen = state.expanded.has(it.id);
  const { shown, more } = authorList(it.authors, 4);

  const authorTxt =
    shown.map(esc).join(', ') + (more ? ` <span class="more">等 ${it.authors.length} 人</span>` : '');

  let corrTxt = '';
  if (it.source === 'biorxiv' && isPi && it.corresponding) {
    const inst = it.institution ? ` <span class="inst">· ${esc(it.institution)}</span>` : '';
    corrTxt = `<div class="card-authors"><span class="corr">通讯 · ${esc(it.corresponding)}</span>${inst}</div>`;
  }

  const abs = it.abstract
    ? `<p class="card-abstract">${esc(it.abstract)}</p>`
    : '';

  const meta =
    it.source === 'biorxiv'
      ? `bioRxiv · ${esc(it.category || '未分类')} · ${shortDate(it.date)}${it.version && it.version !== '1' ? ` · v${esc(it.version)}` : ''}`
      : `${esc(it.journal)} · ${shortDate(it.date)}${typeLabel(it.pubTypes) ? ` · ${typeLabel(it.pubTypes)}` : ''}`;

  return `
  <article class="card${isPi ? ' pi' : ''}${isRead ? ' read' : ''}${isOpen ? ' open' : ''}" data-id="${esc(it.id)}">
    <div class="badges">${badgesHtml(it)}</div>
    <h3 class="card-title">${esc(it.title)}</h3>
    <div class="card-authors">${authorTxt}</div>
    ${corrTxt}
    ${abs}
    <div class="card-foot">
      <span class="meta">${meta}</span>
      <div class="card-actions">
        <button class="act${starred ? ' starred' : ''}" data-act="star" aria-label="收藏">★</button>
        <button class="act" data-act="copy" aria-label="复制引用">复制</button>
        ${it.url ? `<a class="act" href="${esc(it.url)}" target="_blank" rel="noopener" data-act="open">原文</a>` : ''}
      </div>
    </div>
  </article>`;
}

function emptyHtml(title, desc, actionLabel, act) {
  return `<div class="empty">
    <div class="big">${title}</div>
    <div>${desc}</div>
    ${actionLabel ? `<button data-chip="${act}">${actionLabel}</button>` : ''}
  </div>`;
}

function renderContent() {
  const el = $('#content');

  if (state.tab === 'stars') {
    const list = Object.values(state.stars)
      .map((s) => s.item)
      .sort((a, b) => String(b.date).localeCompare(String(a.date)));
    if (!list.length) {
      el.innerHTML = emptyHtml('还没有收藏', '点开任意一篇，按左下角的 ★ 就能存到这里', '去看 bioRxiv', 'go-bx');
      return;
    }
    el.innerHTML = `<div class="stats">共 <b>${list.length}</b> 篇收藏</div>` + list.map(cardHtml).join('');
    return;
  }

  const isBx = state.tab === 'biorxiv';
  const st = isBx ? state.bx : state.jr;

  if (st.error) {
    el.innerHTML = emptyHtml('加载失败', `${esc(st.error)}<br>检查一下网络，或稍后再试`, '重新加载', 'retry');
    return;
  }

  if (st.loading && !st.items.length) {
    el.innerHTML =
      `<div class="progress" id="prog">${esc(st.progress || '正在加载…')}</div>` +
      '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
    return;
  }

  const list = visibleList();
  const total = st.items.length;
  const hits = hitsOf(st.items).length;

  const researchTotal = st.items.filter(isResearch).length;
  const stats = isBx
    ? `${relDay(st.date)} · 共 <b>${total}</b> 篇预印本 · 命中 <b>${hits}</b> 篇`
    : `${shortDate(st.from)} – ${shortDate(st.to)} · 共 <b>${total}</b> 篇（研究类 ${researchTotal}） · 相关 <b>${
        hitsOf(state.researchOnly ? st.items.filter(isResearch) : st.items).length
      }</b> 篇`;

  if (!list.length) {
    const msg = state.query
      ? emptyHtml('没有匹配的结果', '换个词试试，或清空搜索框', '清空搜索', 'clear-q')
      : state.filter[state.tab] === 'hit'
      ? emptyHtml('今天没有命中', '这个日期下没有符合关键词的条目<br>可以切到「全部」看看当天都有什么', '看全部', 'f-all')
      : emptyHtml('暂无数据', isBx ? '这一天没有预印本更新' : '这个时间范围内没有抓到文章', '重新加载', 'retry');
    el.innerHTML = `<div class="stats">${stats}</div>` + msg;
    return;
  }

  const tail = st.loading ? '<div class="progress" id="prog">正在加载其余期刊…</div>' : '';
  el.innerHTML = `<div class="stats">${stats}</div>` + list.map(cardHtml).join('') + tail;
}

// ---------------- 交互 ----------------

let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

function citationOf(it) {
  const names = (it.authors || []).slice(0, 3).join(', ') + ((it.authors || []).length > 3 ? ', et al.' : '');
  const where = it.source === 'biorxiv' ? 'bioRxiv' : it.journal;
  return `${names} (${it.date}). ${it.title}. ${where}.${it.doi ? ` https://doi.org/${it.doi}` : ''}`;
}

function markRead(id) {
  if (state.read[id]) return;
  state.read[id] = Date.now();
  persist.read();
}

function toggleStar(it) {
  if (state.stars[it.id]) {
    delete state.stars[it.id];
    toast('已取消收藏');
  } else {
    const clean = { ...it };
    state.stars[it.id] = { item: clean, ts: Date.now() };
    toast('已收藏');
  }
  persist.stars();
}

function openDatePicker() {
  document.querySelectorAll('input.__ph-date').forEach((el) => el.remove());
  const inp = document.createElement('input');
  inp.type = 'date';
  inp.className = '__ph-date';
  inp.value = state.bx.date;
  inp.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0.01;border:0;padding:0';
  document.body.appendChild(inp);

  inp.addEventListener('change', () => {
    const v = inp.value;
    if (v && v !== state.bx.date) {
      state.bx.date = v;
      loadBiorxiv();
    }
    setTimeout(() => inp.remove(), 500);
  });

  try {
    if (inp.showPicker) inp.showPicker();
    else inp.click();
  } catch {
    inp.click();
  }

  // 用户取消时兜底清理
  setTimeout(() => inp.isConnected && inp.remove(), 60000);
}

function onChip(act) {
  const st = state.bx;
  switch (act) {
    case 'date':
      openDatePicker();
      return;
    case 'today':
      st.date = isoDate();
      loadBiorxiv({ allowFallback: true });
      return;
    case 'f-hit':
      state.filter[state.tab] = 'hit';
      break;
    case 'f-pi':
      state.filter[state.tab] = 'pi';
      break;
    case 'f-all':
      state.filter[state.tab] = 'all';
      break;
    case 'r-7':
    case 'r-14':
    case 'r-30':
      state.jr.days = Number(act.slice(2));
      loadJournals();
      return;
    case 'research':
      state.researchOnly = !state.researchOnly;
      break;
    case 'retry':
      if (state.tab === 'journals') loadJournals({ force: true });
      else loadBiorxiv({ force: true });
      return;
    case 'clear-q':
      state.query = '';
      $('#search').value = '';
      $('#searchrow').hidden = true;
      break;
    case 'go-bx':
      state.tab = 'biorxiv';
      break;
    default:
      return;
  }
  render();
}

function bindEvents() {
  document.querySelectorAll('.tab').forEach((b) => {
    b.addEventListener('click', () => {
      state.tab = b.dataset.tab;
      render();
      if (state.tab === 'journals' && !state.jr.raw.length && !state.jr.loading) loadJournals();
    });
  });

  $('#subbar').addEventListener('click', (e) => {
    const chipEl = e.target.closest('[data-chip]');
    if (chipEl) onChip(chipEl.dataset.chip);
  });

  $('#content').addEventListener('click', async (e) => {
    const chipEl = e.target.closest('[data-chip]');
    if (chipEl) {
      onChip(chipEl.dataset.chip);
      return;
    }
    if (e.target.closest('a')) return;

    const card = e.target.closest('.card');
    if (!card) return;
    const id = card.dataset.id;
    const item = findItem(id);
    if (!item) return;

    const actBtn = e.target.closest('[data-act]');
    if (actBtn) {
      const act = actBtn.dataset.act;
      if (act === 'star') {
        toggleStar(item);
        actBtn.classList.toggle('starred', !!state.stars[id]);
        if (state.tab === 'stars') render();
      } else if (act === 'copy') {
        const ok = await copyText(citationOf(item));
        toast(ok ? '引用已复制' : '复制失败，请手动选择');
      }
      markRead(id);
      card.classList.add('read');
      return;
    }

    card.classList.toggle('open');
    if (card.classList.contains('open')) state.expanded.add(id);
    else state.expanded.delete(id);
    markRead(id);
    card.classList.add('read');
  });

  $('#btn-refresh').addEventListener('click', () => {
    if (state.tab === 'journals') loadJournals({ force: true });
    else if (state.tab === 'stars') render();
    else loadBiorxiv({ force: true });
  });

  $('#btn-search').addEventListener('click', () => {
    const row = $('#searchrow');
    row.hidden = !row.hidden;
    if (!row.hidden) $('#search').focus();
  });

  $('#search').addEventListener(
    'input',
    debounce((e) => {
      state.query = e.target.value;
      renderContent();
    }, 200)
  );

  $('#btn-settings').addEventListener('click', openSettings);
  $('#backdrop').addEventListener('click', closeSheet);
}

function findItem(id) {
  const all = [...state.bx.items, ...state.jr.items];
  const hit = all.find((x) => x.id === id);
  if (hit) return hit;
  if (state.stars[id]) return state.stars[id].item;
  return null;
}

// ---------------- 设置面板 ----------------

function openSettings() {
  const sheet = $('#sheet');
  sheet.innerHTML = `
    <div class="sheet-handle"></div>
    <h2>设置</h2>
    <h3>关键词（每行一个）</h3>
    <textarea id="kw-input" spellcheck="false">${esc(state.keywords)}</textarea>
    <p class="hint">同时匹配标题与摘要，不区分大小写，自动兼容复数与连字符写法。标题命中的权重高于摘要。</p>
    <div class="btnrow">
      <button class="btn primary" id="kw-save">保存并重算</button>
      <button class="btn" id="kw-reset">恢复默认</button>
    </div>

    <h3>关注的通讯作者</h3>
    <div class="pi-list">
      ${PIS.map(
        (p) => `<div class="pi-row"><span class="n">${esc(p.name)}</span><span class="f">${esc(p.field)}</span></div>`
      ).join('')}
    </div>
    <p class="hint">bioRxiv 用通讯作者全名精确匹配；期刊只给姓名缩写，因此只在「压轴作者」位置上标记，并标注为需人工确认。</p>

    <h3>数据</h3>
    <div class="btnrow">
      <button class="btn" id="clear-read">清除已读标记</button>
      <button class="btn danger" id="clear-cache">清除缓存数据</button>
    </div>
    <p class="hint">所有数据只存在这台手机上，不上传、不需要账号。</p>

    <h3>关于</h3>
    <p class="about">
      文献雷达 v${APP.version} · 纯前端 PWA<br>
      数据来源：bioRxiv API、Europe PMC（覆盖 Nature / Science / Cell / Nature Methods / Nature Biotechnology）<br>
      把本页「添加到主屏幕」，就是独立图标、全屏运行的 App。
    </p>
  `;

  $('#kw-save').addEventListener('click', () => {
    state.keywords = $('#kw-input').value;
    persist.keywords();
    applyEval();
    render();
    closeSheet();
    toast('关键词已更新');
  });

  $('#kw-reset').addEventListener('click', () => {
    $('#kw-input').value = DEFAULT_KEYWORDS.join('\n');
    toast('已恢复默认，记得点保存');
  });

  $('#clear-read').addEventListener('click', () => {
    state.read = {};
    stateSet(LS_KEYS.read, {});
    render();
    toast('已清除已读标记');
  });

  $('#clear-cache').addEventListener('click', async () => {
    await cacheClear();
    state.bx.raw = [];
    state.jr.raw = [];
    state.bx.items = [];
    state.jr.items = [];
    render();
    toast('缓存已清空');
  });

  $('#backdrop').hidden = false;
  sheet.hidden = false;
}

function closeSheet() {
  $('#sheet').hidden = true;
  $('#backdrop').hidden = true;
}

// ---------------- 启动 ----------------

function readUrlState() {
  const p = new URLSearchParams(location.search);
  const one = (k) => p.get(k) || '';
  const date = one('date');
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) state.bx.date = date;
  const tab = one('tab');
  if (['biorxiv', 'journals', 'stars'].includes(tab)) state.tab = tab;
  const days = Number(one('days'));
  if ([7, 14, 30].includes(days)) state.jr.days = days;
}

function syncUrl() {
  const p = new URLSearchParams();
  p.set('tab', state.tab);
  if (state.tab === 'biorxiv') p.set('date', state.bx.date);
  if (state.tab === 'journals') p.set('days', String(state.jr.days));
  try {
    history.replaceState(null, '', `${location.pathname}?${p}`);
  } catch {
    /* file:// 下可能失败，忽略 */
  }
}

function boot() {
  readUrlState();
  bindEvents();
  applyEval();
  render();
  if (state.tab === 'journals') loadJournals();
  loadBiorxiv({ allowFallback: true }).then(() => {
    // 后台预热期刊数据，切过去就不用等；弱网/省流量模式下跳过，免得白耗流量
    const conn = navigator.connection || {};
    const slow = conn.saveData || /(^|-)2g$|(^|-)3g$/.test(conn.effectiveType || '');
    if (!slow && !state.jr.raw.length && !state.jr.loading) loadJournals();
  });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    });
  }
}

boot();
