// FRED API — Fed 유동성 · 미 국채 · 정책금리 · 크레딧 스프레드 · 순유동성 지수
// Node.js Runtime
export const config = { maxDuration: 30 };

const BASE = 'https://api.stlouisfed.org/fred/series/observations';

// 시리즈별 조회 개수 (순유동성 52주 백분위 계산을 위해 주간 시리즈는 70개, RRP 일간은 400개)
const SERIES = {
  WALCL:        { limit: 70 },   // Fed 총자산      (백만 달러, 주간)
  WTREGEN:      { limit: 70 },   // TGA 잔고        (백만 달러, 주간)
  WRESBAL:      { limit: 3 },    // 지급준비금      (백만 달러, 주간)
  RRPONTSYD:    { limit: 400 },  // 역레포 잔고     (십억 달러, 일간)  ← 단위 주의
  TREAST:       { limit: 2 },    // 보유 국채       (백만 달러, 주간)
  WSHOMCB:      { limit: 2 },    // 보유 MBS        (백만 달러, 주간)
  DGS2:         { limit: 3 },    // 미 국채 2년     (%, 일간)
  DGS10:        { limit: 3 },    // 미 국채 10년    (%, 일간)
  SOFR:         { limit: 2 },
  EFFR:         { limit: 2 },
  IORB:         { limit: 2 },
  BAMLH0A0HYM2: { limit: 3 },    // US HY OAS (%)
  BAMLC0A0CM:   { limit: 3 },    // US IG OAS (%)
};

const FED_PEAK_M = 8965487; // 2022-04 Fed 총자산 고점 (백만 달러) — 역사적 상수

// 단위 변환 → 억달러(1e8 USD)
const fromMillions = v => (v == null ? null : Math.round(v / 100));        // 백만 → 억
const fromBillions = v => (v == null ? null : Math.round(v * 10));         // 십억 → 억
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

async function fetchSeries(id, apiKey, limit) {
  const url = `${BASE}?series_id=${id}&api_key=${apiKey}&file_type=json&sort_order=desc&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FRED ${id}: ${res.status}`);
  const json = await res.json();
  return (json.observations ?? [])
    .filter(o => o.value !== '.' && o.value != null)
    .map(o => ({ date: o.date, value: parseFloat(o.value) }));  // 최신순
}

function latestPair(obs, conv = v => v) {
  const a = obs?.[0], b = obs?.[1];
  const value = a ? conv(a.value) : null;
  const prev  = b ? conv(b.value) : null;
  return { value, prev, change: value != null && prev != null ? value - prev : null, date: a?.date ?? null };
}

// ── 순유동성 = Fed 총자산 − TGA − RRP  (모두 백만 달러로 정렬) ──
function buildNetLiquidity(walcl, tga, rrp) {
  const tgaByDate = new Map(tga.map(o => [o.date, o.value]));
  const out = [];
  let j = 0;
  for (const w of walcl) {                               // walcl: 최신순
    const t = tgaByDate.get(w.date);
    if (t == null) continue;
    while (j < rrp.length && rrp[j].date > w.date) j++;  // w.date 이하 가장 최근 RRP
    const r = rrp[j]?.value ?? 0;
    out.push({ date: w.date, net: w.value - t - r * 1000 });
  }
  return out;
}

// 점수(0~100): 4주 변화율(±25) + 52주 내 위치(±25)
function scoreAt(net, i) {
  if (i + 4 >= net.length) return null;
  const cur = net[i].net;
  const chg4 = ((cur - net[i + 4].net) / net[i + 4].net) * 100;
  const win = net.slice(i, i + 52).map(x => x.net);
  if (win.length < 12) return null;
  const below = win.filter(v => v < cur).length;
  const pctile = (below / (win.length - 1)) * 100;
  const score = Math.round(clamp(50 + clamp(chg4 * 10, -25, 25) + (pctile - 50) * 0.5, 0, 100));
  return { score, chg4, pctile, win: win.length };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) return res.status(500).json({ ok: false, error: 'FRED_API_KEY 환경변수가 없습니다' });

  const ids = Object.keys(SERIES);
  const settled = await Promise.allSettled(ids.map(id => fetchSeries(id, apiKey, SERIES[id].limit)));
  const S = {}, errors = {};
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') S[ids[i]] = r.value;
    else errors[ids[i]] = r.reason?.message;
  });

  const unit = '억달러';
  const data = {};

  // ── 기존 4종 (키 이름 유지: 프런트 호환) ──
  data.fed_balance_sheet = S.WALCL     ? { ...latestPair(S.WALCL, fromMillions), unit }     : { value: null, error: errors.WALCL };
  data.reserves          = S.WRESBAL   ? { ...latestPair(S.WRESBAL, fromMillions), unit }   : { value: null, error: errors.WRESBAL };
  data.tga               = S.WTREGEN   ? { ...latestPair(S.WTREGEN, fromMillions), unit }   : { value: null, error: errors.WTREGEN };
  // RRPONTSYD는 '십억 달러' 단위 → 억달러로는 ×10 (이전 코드는 ÷100 하여 거의 0으로 표시됨)
  data.rrp               = S.RRPONTSYD ? { ...latestPair(S.RRPONTSYD, fromBillions), unit, freq: 'daily' } : { value: null, error: errors.RRPONTSYD };

  // ── Fed 자산 구성 ──
  if (S.WALCL && S.TREAST && S.WSHOMCB) {
    const total = S.WALCL[0].value, tsy = S.TREAST[0].value, mbs = S.WSHOMCB[0].value;
    data.fed_composition = {
      treasury: fromMillions(tsy),
      mbs: fromMillions(mbs),
      other: fromMillions(total - tsy - mbs),
      total: fromMillions(total),
      peak: fromMillions(FED_PEAK_M),
      peak_label: '2022.04',
      shrink_pct: ((total - FED_PEAK_M) / FED_PEAK_M) * 100,
      date: S.WALCL[0].date,
      unit,
    };
  }

  // ── 정책금리 ──
  const rate = id => (S[id]?.length ? { value: S[id][0].value, prev: S[id][1]?.value ?? null, date: S[id][0].date } : null);
  data.policy_rates = { sofr: rate('SOFR'), effr: rate('EFFR'), iorb: rate('IORB') };

  // ── 미 국채 2년 · 10Y−2Y 스프레드 (Yahoo ^IRX는 13주 T-Bill이라 2년물이 아님) ──
  data.us_rates = { us2y: rate('DGS2'), us10y: rate('DGS10') };
  if (S.DGS2?.length && S.DGS10?.length) {
    const d10 = new Map(S.DGS10.map(o => [o.date, o.value]));
    const rows = S.DGS2.filter(o => d10.has(o.date)).map(o => ({ date: o.date, v: d10.get(o.date) - o.value }));
    if (rows.length) data.us_rates.spread = { value: rows[0].v, prev: rows[1]?.v ?? null, date: rows[0].date };
  }

  // ── 크레딧 스프레드 (OAS %, → bp) ──
  const bp = id => (S[id]?.length ? {
    value: Math.round(S[id][0].value * 100),
    prev: S[id][1] ? Math.round(S[id][1].value * 100) : null,
    date: S[id][0].date,
  } : null);
  data.credit_spreads = { us_hy: bp('BAMLH0A0HYM2'), us_ig: bp('BAMLC0A0CM') };

  // ── 순유동성 지수 ──
  if (S.WALCL && S.WTREGEN && S.RRPONTSYD) {
    const net = buildNetLiquidity(S.WALCL, S.WTREGEN, S.RRPONTSYD);
    const now = scoreAt(net, 0);
    if (now) {
      const w1 = scoreAt(net, 1), w4 = scoreAt(net, 4);
      data.net_liquidity = {
        value: fromMillions(net[0].net),
        prev_4w: fromMillions(net[4].net),
        chg4w_pct: now.chg4,
        percentile: now.pctile,
        window_weeks: now.win,
        score: now.score,
        score_1w: w1?.score ?? null,
        score_4w: w4?.score ?? null,
        date: net[0].date,
        unit,
      };
    }
  }

  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=300');
  return res.status(200).json({ ok: true, data, ...(Object.keys(errors).length ? { errors } : {}), ts: Date.now() });
}
