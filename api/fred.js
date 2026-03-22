export const config = { runtime: 'edge' };

// FRED 시리즈 코드
const SERIES = {
  WALCL:     'fed_balance_sheet',  // Fed 대차대조표 (단위: 백만달러)
  WRESBAL:   'reserves',           // 지급준비금
  RRPONTSYD: 'rrp',                // RRP 역레포 잔고
  WTREGEN:   'tga',                // TGA 재무부 일반계정
};

async function fetchSeries(id, apiKey) {
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${id}&api_key=${apiKey}&file_type=json&sort_order=desc&limit=2`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FRED ${id} error: ${res.status}`);
  const json = await res.json();
  const obs = json.observations ?? [];
  // 최신 유효값 찾기 (missing value = '.')
  const latest = obs.find(o => o.value !== '.');
  const prev   = obs.filter(o => o.value !== '.')[1];
  return {
    value:  latest ? parseFloat(latest.value) : null,
    date:   latest?.date ?? null,
    prev:   prev   ? parseFloat(prev.value)   : null,
  };
}

export default async function handler() {
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ ok: false, error: 'FRED_API_KEY 환경변수 없음' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }

  try {
    // 병렬로 4개 시리즈 동시 조회
    const results = await Promise.all(
      Object.keys(SERIES).map(id => fetchSeries(id, apiKey))
    );

    const data = {};
    Object.entries(SERIES).forEach(([id, key], i) => {
      const r = results[i];
      // 단위 변환: FRED는 백만달러 → 억달러로 표시
      const toHundredMillion = v => v ? Math.round(v / 100) : null;
      data[key] = {
        raw:    r.value,
        value:  toHundredMillion(r.value),   // 억달러
        prev:   toHundredMillion(r.prev),
        change: r.value && r.prev ? toHundredMillion(r.value - r.prev) : null,
        date:   r.date,
        unit:   '억달러',
      };
    });

    return new Response(JSON.stringify({ ok: true, data, ts: Date.now() }), {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 's-maxage=3600', // 1시간 캐시 (주간 데이터라 충분)
      },
    });

  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
}
