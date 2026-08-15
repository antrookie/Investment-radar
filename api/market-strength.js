export const config = { runtime: 'edge' };

// =============================================
// 오늘의 시장 강도 (단기 매매 적합도) 데이터 API
// =============================================
// 주식(KOSPI)과 코인(BTC) 두 시장에 대해 각각 계산해서 반환한다.
//   1) 오늘의 등락률/거래량/20일 평균 대비 거래량 배율
//   2) 최근 60거래일(코인은 60일, 24시간 거래) 중 최고/최악의 날(등락률 기준)
//   3) 오늘 하루의 5분 간격 거래량 추이(시간대별 거래대금 근사치)
//   4) 실현 변동성(최근 20일 등락률의 표준편차) — 코인은 VIX 같은 무료 공포지수가
//      없어서, 대신 이 값으로 '변동성이 얼마나 큰 시장인지'를 판단한다.
//
// 주의: 여기서 쓰는 '거래량/거래대금'은 지수(코스피)·BTC 가격 기준 근사치이며,
// 실제 원화/달러 총거래대금과는 차이가 있을 수 있다.
// 코스피 쪽 더 정확한 값은 KRX Open API 승인 후 investor-flow.js 등에서 대체 예정.

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json',
};

async function fetchDailyChart(symbol, range = '3mo') {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`daily chart ${symbol} ${res.status}`);
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error(`daily chart ${symbol} 빈 응답`);

  const ts = result.timestamp ?? [];
  const q = result.indicators?.quote?.[0] ?? {};
  const closes = q.close ?? [];
  const volumes = q.volume ?? [];

  return ts
    .map((t, i) => ({
      date: new Date(t * 1000).toISOString().slice(0, 10),
      close: closes[i] ?? null,
      volume: volumes[i] ?? null,
    }))
    .filter((d) => d.close != null && d.volume != null);
}

async function fetchIntraday(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=5m`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`intraday ${symbol} ${res.status}`);
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result) return [];

  const ts = result.timestamp ?? [];
  const q = result.indicators?.quote?.[0] ?? {};
  const volumes = q.volume ?? [];
  const closes = q.close ?? [];

  return ts
    .map((t, i) => ({
      time: new Date(t * 1000).toISOString().slice(11, 16),
      volume: volumes[i] ?? 0,
      close: closes[i] ?? null,
    }))
    .filter((d) => d.close != null);
}

function computeDailyChanges(days) {
  const out = [];
  for (let i = 1; i < days.length; i++) {
    const prev = days[i - 1].close;
    const cur = days[i].close;
    const pct = ((cur - prev) / prev) * 100;
    out.push({ ...days[i], pct });
  }
  return out;
}

// 최근 N일 등락률의 표준편차 (실현 변동성, %) — 코인 시장의 'VIX 대용'으로 사용
function computeRealizedVolatility(changes, n = 20) {
  const recent = changes.slice(-n).map((d) => d.pct);
  if (recent.length < 2) return null;
  const mean = recent.reduce((s, v) => s + v, 0) / recent.length;
  const variance = recent.reduce((s, v) => s + (v - mean) ** 2, 0) / recent.length;
  return Math.sqrt(variance);
}

// 심볼 하나에 대해 강도 지표에 필요한 데이터 전부를 계산한다 (주식/코인 공용)
async function computeMarketData(symbol, { intradaySymbol = symbol, chartRange = '3mo' } = {}) {
  const days = await fetchDailyChart(symbol, chartRange);
  const changes = computeDailyChanges(days);
  if (changes.length < 21) throw new Error(`${symbol} 데이터 부족 (최소 21일 필요)`);

  const today = changes[changes.length - 1];
  const last20 = changes.slice(-21, -1);
  const avgVolume20 = last20.reduce((s, d) => s + d.volume, 0) / last20.length;
  const volumeRatio = avgVolume20 > 0 ? today.volume / avgVolume20 : null;

  const window = changes.slice(-60);
  const bestDay = window.reduce((a, b) => (b.pct > a.pct ? b : a));
  const worstDay = window.reduce((a, b) => (b.pct < a.pct ? b : a));

  const realizedVol = computeRealizedVolatility(changes, 20);

  let intraday = [];
  try {
    intraday = await fetchIntraday(intradaySymbol);
  } catch (e) {
    intraday = [];
  }

  const estTradingValue = today.close * today.volume;

  return {
    today: {
      date: today.date,
      pct: today.pct,
      volume: today.volume,
      volumeRatio,
      estTradingValue,
      realizedVol,
    },
    bestDay: { date: bestDay.date, pct: bestDay.pct, volume: bestDay.volume },
    worstDay: { date: worstDay.date, pct: worstDay.pct, volume: worstDay.volume },
    intraday,
  };
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET' },
    });
  }

  try {
    // 코스피와 BTC를 병렬로 계산. 하나가 실패해도 다른 하나는 반환되도록 allSettled 사용.
    const [stockResult, cryptoResult] = await Promise.allSettled([
      computeMarketData('^KS11'),
      computeMarketData('BTC-USD', { chartRange: '3mo' }),
    ]);

    const data = {
      stock: stockResult.status === 'fulfilled' ? stockResult.value : null,
      crypto: cryptoResult.status === 'fulfilled' ? cryptoResult.value : null,
    };

    if (!data.stock && !data.crypto) {
      throw new Error(
        `stock: ${stockResult.reason?.message}, crypto: ${cryptoResult.reason?.message}`
      );
    }

    return new Response(JSON.stringify({ ok: true, data, ts: Date.now() }), {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 's-maxage=300, stale-while-revalidate=60',
      },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
}

