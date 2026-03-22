export const config = { runtime: 'edge' };

// 조회할 심볼 목록
const SYMBOLS = {
  stocks: ['^GSPC', '^IXIC', '^DJI', '^VIX', '^KS11', '^KQ11'],
  forex:  ['KRW=X', 'EURKRW=X', 'JPYKRW=X', 'DX-Y.NYB', 'CNY=X'],
  bonds:  ['^TNX', '^FVX', '^IRX', '^TYX'],
  extra:  ['GC=F', 'CL=F', 'BTC-USD', 'ETH-USD'],
};

const ALL = Object.values(SYMBOLS).flat().join(',');

export default async function handler() {
  try {
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${ALL}&fields=regularMarketPrice,regularMarketChange,regularMarketChangePercent,regularMarketPreviousClose,fiftyTwoWeekHigh,fiftyTwoWeekLow,regularMarketVolume,shortName`;

    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });

    if (!res.ok) throw new Error(`Yahoo API error: ${res.status}`);

    const json = await res.json();
    const quotes = json?.quoteResponse?.result ?? [];

    // 심볼 → 데이터 맵으로 변환
    const map = {};
    for (const q of quotes) {
      map[q.symbol] = {
        name:    q.shortName ?? q.symbol,
        price:   q.regularMarketPrice,
        change:  q.regularMarketChange,
        pct:     q.regularMarketChangePercent,
        prev:    q.regularMarketPreviousClose,
        high52:  q.fiftyTwoWeekHigh,
        low52:   q.fiftyTwoWeekLow,
        volume:  q.regularMarketVolume,
      };
    }

    return new Response(JSON.stringify({ ok: true, data: map, ts: Date.now() }), {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 's-maxage=300', // 5분 캐시
      },
    });

  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
