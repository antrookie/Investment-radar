// 한국은행 ECOS API — 국고채 금리 · 기준금리 · 회사채 · 증시주변자금(신용융자/예탁금/미수금)
// Node.js Runtime
export const config = { maxDuration: 30 };

const BASE = 'https://ecos.bok.or.kr/api/StatisticSearch';

// ── 날짜 유틸 (KST 기준) ─────────────────────────────
function kstNow() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000);
}
function ymd(d) { return d.toISOString().slice(0, 10).replace(/-/g, ''); }
function ym(d)  { return d.toISOString().slice(0, 7).replace(/-/g, ''); }
function daysAgo(n)   { const d = kstNow(); d.setUTCDate(d.getUTCDate() - n); return d; }
function monthsAgo(n) { const d = kstNow(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - n); return d; }

const norm = s => (s ?? '').replace(/\s/g, '');
const num  = s => {
  if (s == null || s === '') return null;
  const v = parseFloat(String(s).replace(/,/g, ''));
  return Number.isFinite(v) ? v : null;
};

// ── ECOS 호출: 항목코드 없이 통계표 전체를 받아 이름으로 매칭 ──
// (항목코드를 잘못 넣어서 빈 응답이 오는 문제를 원천 차단)
async function fetchTable(apiKey, stat, cycle, start, end, item = '') {
  const url = `${BASE}/${apiKey}/json/kr/1/2000/${stat}/${cycle}/${start}/${end}` + (item ? `/${item}` : '');
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`ECOS ${stat} HTTP ${res.status}`);
  const json = await res.json();
  if (json?.RESULT) {
    // INFO-200 = 해당 데이터 없음, 그 외는 오류
    if (json.RESULT.CODE === 'INFO-200') return [];
    throw new Error(`ECOS ${stat} ${json.RESULT.CODE}: ${json.RESULT.MESSAGE}`);
  }
  return json?.StatisticSearch?.row ?? [];
}

// 항목별로 묶어서 최신값/직전값 추출
function groupLatest(rows) {
  const by = {};
  for (const r of rows) {
    const key = norm(r.ITEM_NAME1);
    (by[key] ??= { code: r.ITEM_CODE1, name: r.ITEM_NAME1, unit: r.UNIT_NAME, rows: [] }).rows.push(r);
  }
  for (const g of Object.values(by)) {
    g.rows = g.rows.filter(r => num(r.DATA_VALUE) != null).sort((a, b) => b.TIME.localeCompare(a.TIME));
    g.value = num(g.rows[0]?.DATA_VALUE);
    g.prev  = num(g.rows[1]?.DATA_VALUE);
    g.date  = g.rows[0]?.TIME ?? null;
  }
  return by;
}

// 이름 후보(공백 무시) → 없으면 항목코드로 찾기
function pick(groups, names, codes = []) {
  for (const n of names) if (groups[norm(n)]) return groups[norm(n)];
  for (const g of Object.values(groups)) if (codes.includes(g.code)) return g;
  return null;
}
const out = (g, scale = 1) => g ? {
  value: g.value != null ? g.value * scale : null,
  prev:  g.prev  != null ? g.prev  * scale : null,
  date:  g.date,
} : null;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const apiKey = process.env.ECOS_API_KEY;
  if (!apiKey) return res.status(500).json({ ok: false, error: 'ECOS_API_KEY 환경변수가 없습니다' });

  const debug = req.query?.debug === '1';
  const errors = {};
  const data = {};
  const seen = {};

  const [ratesR, baseR, fundsR] = await Promise.allSettled([
    // 1.3.2.1 시장금리(일별) — 최근 20일
    fetchTable(apiKey, '817Y002', 'D', ymd(daysAgo(20)), ymd(kstNow())),
    // 1.3.1 한국은행 기준금리 — 최근 120일
    fetchTable(apiKey, '722Y001', 'D', ymd(daysAgo(120)), ymd(kstNow()), '0101000'),
    // 1.5.1.4 증시주변자금동향(월) — 최근 6개월
    fetchTable(apiKey, '901Y056', 'M', ym(monthsAgo(6)), ym(kstNow())),
  ]);

  // ── 시장금리 ──
  if (ratesR.status === 'fulfilled') {
    const g = groupLatest(ratesR.value);
    if (debug) seen.rates = Object.values(g).map(x => `${x.code} ${x.name}`);
    data.rates = {
      ktb1y:  out(pick(g, ['국고채(1년)'],  ['010190000'])),
      ktb3y:  out(pick(g, ['국고채(3년)'],  ['010200000'])),
      ktb5y:  out(pick(g, ['국고채(5년)'],  ['010200001'])),
      ktb10y: out(pick(g, ['국고채(10년)'], ['010210000'])),
      corpAA:  out(pick(g, ['회사채(3년,AA-)', '회사채(무보증3년,AA-)'])),
      corpBBB: out(pick(g, ['회사채(3년,BBB-)', '회사채(무보증3년,BBB-)'])),
      cd91:    out(pick(g, ['CD(91일)'])),
    };
  } else errors.rates = ratesR.reason?.message;

  // ── 기준금리 ──
  if (baseR.status === 'fulfilled') {
    const rows = baseR.value
      .filter(r => num(r.DATA_VALUE) != null)
      .sort((a, b) => b.TIME.localeCompare(a.TIME));
    if (rows.length) {
      const latest = num(rows[0].DATA_VALUE);
      // 직전 '다른 값'을 찾아 인상/인하 판단 (120일 내 변화 없으면 동결)
      const diffRow = rows.find(r => num(r.DATA_VALUE) !== latest);
      data.base_rate = {
        value: latest,
        prev: diffRow ? num(diffRow.DATA_VALUE) : latest,
        date: rows[0].TIME,
      };
    }
  } else errors.base_rate = baseR.reason?.message;

  // ── 증시주변자금 (단위: 백만원 → 억원) ──
  if (fundsR.status === 'fulfilled') {
    const g = groupLatest(fundsR.value);
    if (debug) seen.funds = Object.values(g).map(x => `${x.code} ${x.name}`);
    const toUk = 1 / 100;
    data.market_funds = {
      margin_loan: out(pick(g, ['신용융자잔고', '신용융자잔고2)'], ['S23E']), toUk),
      deposit:     out(pick(g, ['투자자예탁금'], ['S23A']), toUk),
      unsettled:   out(pick(g, ['위탁매매미수금'], ['S23D']), toUk),
      unit: '억원',
    };
  } else errors.market_funds = fundsR.reason?.message;

  const ok = Object.keys(data).length > 0;
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=600');
  return res.status(ok ? 200 : 502).json({
    ok, data, ts: Date.now(),
    ...(Object.keys(errors).length ? { errors } : {}),
    ...(debug ? { seen } : {}),
  });
}
