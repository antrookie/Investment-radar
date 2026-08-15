export const config = { runtime: 'edge' };

// =============================================
// 오늘의 시장 강도 (단기 매매 적합도) 데이터 API
// =============================================
// 이 API는 KOSPI(^KS11) 지수의 일별/5분봉 데이터를 야후 파이낸스에서 가져와
// 아래 세 가지를 계산해서 반환한다.
//   1) 오늘의 등락률/거래량/20일 평균 대비 거래량 배율
//   2) 최근 60거래일 중 최고/최악의 날(등락률 기준)
//   3) 오늘 하루의 5분 간격 거래량 추이(시간대별 거래대금 근사치)
//
// 주의: 여기서 쓰는 '거래량/거래대금'은 지수(코스피) 기준 근사치이며,
// 실제 한국거래소가 발표하는 시장 전체 원화 거래대금과는 차이가 있을 수 있다.
// 더 정확한 값은 KRX Open API 승인 후 investor-flow.js 등에서 대체 예정.

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

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET' },
    });
  }

  try {
    const days = await fetchDailyChart('^KS11', '3mo');
    const changes = computeDailyChanges(days);
    if (changes.length < 21) throw new Error('데이터 부족 (최소 21거래일 필요)');

    const today = changes[changes.length - 1];
    // 오늘을 제외한 직전 20거래일 평균 거래량
    const last20 = changes.slice(-21, -1);
    const avgVolume20 = last20.reduce((s, d) => s + d.volume, 0) / last20.length;
    const volumeRatio = avgVolume20 > 0 ? today.volume / avgVolume20 : null;

    // 최근 60거래일(데이터가 있는 만큼) 중 최고/최악의 날
    const window = changes.slice(-60);
    const bestDay = window.reduce((a, b) => (b.pct > a.pct ? b : a));
    const worstDay = window.reduce((a, b) => (b.pct < a.pct ? b : a));

    let intraday = [];
    try {
      intraday = await fetchIntraday('^KS11');
    } catch (e) {
      intraday = []; // 장 마감 후이거나 실패 시 빈 배열로, 프론트에서 처리
    }

    // 거래대금 근사치 (종가 × 거래량). 실제 원화 총거래대금과는 오차가 있음.
    const estTradingValue = today.close * today.volume;

    const data = {
      today: {
        date: today.date,
        pct: today.pct,
        volume: today.volume,
        volumeRatio,
        estTradingValue,
      },
      bestDay: { date: bestDay.date, pct: bestDay.pct, volume: bestDay.volume },
      worstDay: { date: worstDay.date, pct: worstDay.pct, volume: worstDay.volume },
      intraday,
    };

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
