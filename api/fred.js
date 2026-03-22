export const config = { runtime: 'edge' };

const SERIES = {
  WALCL:     'fed_balance_sheet',
  WRESBAL:   'reserves',
  RRPONTSYD: 'rrp',
  WTREGEN:   'tga',
};

async function fetchOne(id, apiKey) {
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${id}&api_key=${apiKey}&file_type=json&sort_order=desc&limit=2&realtime_start=2020-01-01`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000); // 6초 타임아웃
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const json = await res.json();
    const obs = (json.observations ?? []).filter(o => o.value !== '.');
    const latest = obs[0];
    const prev   = obs[1];
    return {
      value:  latest ? parseFloat(latest.value) : null,
      date:   latest?.date ?? null,
      prev:   prev   ? parseFloat(prev.value)   : null,
    };
  } catch {
    clearTimeout(timer);
    return null;
  }
}

export default async function handler() {
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ ok: false, error: 'FRED_API_KEY 없음' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }

  // 4개 동시 요청 (Promise.allSettled — 하나 실패해도 나머지 반환)
  const entries = Object.entries(SERIES);
  const results = await Promise.allSettled(
    entries.map(([id]) => fetchOne(id, apiKey))
  );

  const toHundredMillion = v => v != null ? Math.round(v / 100) : null;

  const data = {};
  entries.forEach(([id, key], i) => {
    const r = results[i].status === 'fulfilled' ? results[i].value : null;
    if (!r) { data[key] = null; return; }
    const val  = toHundredMillion(r.value);
    const prev = toHundredMillion(r.prev);
    data[key] = {
      value:  val,
      prev:   prev,
      change: val != null && prev != null ? val - prev : null,
      date:   r.date,
      unit:   '억달러',
    };
  });

  return new Response(JSON.stringify({ ok: true, data, ts: Date.now() }), {
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 's-maxage=3600, stale-while-revalidate=300',
    },
  });
}
