export const config = { maxDuration: 30 };

// 날짜 계산 (영업일 기준)
function getDateStr(daysAgo = 1) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  while (d.getDay() === 0 || d.getDay() === 6) {
    d.setDate(d.getDate() - 1);
  }
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

async function fetchEcos(apiKey, seriesCode, itemCode) {
  const endDate = getDateStr(1);
  const startDate = getDateStr(30); // 최근 30일 중 최신값
  const url = `https://ecos.bok.or.kr/api/StatisticSearch/${apiKey}/json/kr/1/5/${seriesCode}/D/${startDate}/${endDate}/${itemCode}`;

  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  if (!res.ok) throw new Error(`ECOS ${seriesCode} ${res.status}`);
  const json = await res.json();

  // 최신 데이터 추출
  const rows = json?.StatisticSearch?.row ?? [];
  if (rows.length === 0) return null;

  // 날짜 내림차순 정렬 후 최신 2개
  rows.sort((a, b) => b.TIME.localeCompare(a.TIME));
  const latest = rows[0];
  const prev   = rows[1] ?? null;

  return {
    value: latest?.DATA_VALUE ? parseFloat(latest.DATA_VALUE.replace(/,/g, '')) : null,
    date:  latest?.TIME ?? null,
    prev:  prev?.DATA_VALUE   ? parseFloat(prev.DATA_VALUE.replace(/,/g, ''))   : null,
  };
}

export default async function handler(req, res) {
  const apiKey = process.env.ECOS_API_KEY ?? 'sample';

  try {
    // ECOS 통계 코드
    // 027Y151: 신용융자 잔고 (KOSPI/KOSDAQ)
    // 027Y152: 공매도 잔고
    const [creditKospi, creditKosdaq, shortKospi, shortKosdaq] = await Promise.allSettled([
      fetchEcos(apiKey, '027Y151', 'S'),   // 신용융자 KOSPI
      fetchEcos(apiKey, '027Y151', 'K'),   // 신용융자 KOSDAQ
      fetchEcos(apiKey, '027Y152', 'S'),   // 공매도 KOSPI
      fetchEcos(apiKey, '027Y152', 'K'),   // 공매도 KOSDAQ
    ]);

    const get = r => r.status === 'fulfilled' ? r.value : null;

    const toUk = v => v != null ? Math.round(v / 100000000) : null; // 원 → 억원

    const ck = get(creditKospi);
    const cq = get(creditKosdaq);
    const sk = get(shortKospi);
    const sq = get(shortKosdaq);

    const data = {
      credit: {
        kospi:  ck ? toUk(ck.value) : null,
        kosdaq: cq ? toUk(cq.value) : null,
        kospi_prev:  ck ? toUk(ck.prev) : null,
        kosdaq_prev: cq ? toUk(cq.prev) : null,
        date: ck?.date ?? null,
      },
      short_selling: {
        kospi:  sk ? toUk(sk.value) : null,
        kosdaq: sq ? toUk(sq.value) : null,
        kospi_prev:  sk ? toUk(sk.prev) : null,
        kosdaq_prev: sq ? toUk(sq.prev) : null,
        date: sk?.date ?? null,
      },
    };

    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=300');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).json({ ok: true, data, ts: Date.now() });

  } catch (e) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(500).json({ ok: false, error: e.message });
  }
}
