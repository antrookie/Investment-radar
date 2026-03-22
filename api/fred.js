// Node.js Runtime 사용 (Edge보다 안정적)
export const config = { maxDuration: 30 };

const SERIES_MAP = {
  WALCL:     'fed_balance_sheet',
  WRESBAL:   'reserves',
  RRPONTSYD: 'rrp',
  WTREGEN:   'tga',
};

const toHundredMillion = v => v != null ? Math.round(v / 100) : null;

async function fetchSeries(id, apiKey) {
  const url = `https://api.stlouisfed.org/fred/series/observations` +
    `?series_id=${id}` +
    `&api_key=${apiKey}` +
    `&file_type=json` +
    `&sort_order=desc` +
    `&limit=2`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`FRED ${id}: ${res.status}`);
  const json = await res.json();
  const obs = (json.observations ?? []).filter(o => o.value !== '.');
  return {
    value: obs[0] ? parseFloat(obs[0].value) : null,
    date:  obs[0]?.date ?? null,
    prev:  obs[1] ? parseFloat(obs[1].value) : null,
  };
}

export default async function handler(req, res) {
  const apiKey = process.env.FRED_API_KEY;

  if (!apiKey) {
    return res.status(500).json({ ok: false, error: 'FRED_API_KEY 환경변수가 없습니다' });
  }

  // 4개를 순차적으로 호출 (병렬 X → 서버 부하 감소)
  const data = {};
  for (const [id, key] of Object.entries(SERIES_MAP)) {
    try {
      const r = await fetchSeries(id, apiKey);
      const val  = toHundredMillion(r.value);
      const prev = toHundredMillion(r.prev);
      data[key] = {
        value:  val,
        prev:   prev,
        change: val != null && prev != null ? val - prev : null,
        date:   r.date,
        unit:   '억달러',
      };
    } catch (e) {
      data[key] = { value: null, error: e.message };
    }
  }

  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=300');
  res.setHeader('Access-Control-Allow-Origin', '*');
  return res.status(200).json({ ok: true, data, ts: Date.now() });
}
