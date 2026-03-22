export const config = { runtime: 'edge' };

const SYMBOLS = [
  '^GSPC', '^IXIC', '^DJI', '^VIX',
  '^KS11', '^KQ11',
  'KRW=X', 'EURKRW=X', 'JPYKRW=X', 'DX-Y.NYB', 'CNY=X',
  '^TNX', '^FVX', '^IRX', '^TYX',
  'GC=F', 'CL=F', 'BTC-USD', 'ETH-USD',
];

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET' },
    });
  }

  try {
    // Step 1: crumb + cookie 획득
    const crumbRes = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
    });
    const crumb = await crumbRes.text();
    const cookie = crumbRes.headers.get('set-cookie') ?? '';

    const syms = SYMBOLS.join('%2C');
    const fields = 'regularMarketPrice%2CregularMarketChange%2CregularMarketChangePercent%2CregularMarketPreviousClose%2CfiftyTwoWeekHigh%2CfiftyTwoWeekLow%2CshortName%2CregularMarketTime';
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${syms}&fields=${fields}&crumb=${encodeURIComponent(crumb)}`;

    const quoteRes = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.5',
        'Cookie': cookie,
      },
    });

    if (!quoteRes.ok) throw new Error(`v7 API ${quoteRes.status}`);
    const json = await quoteRes.json();
    const quotes = json?.quoteResponse?.result ?? [];
    if (quotes.length === 0) throw new Error('빈 응답');

    const map = {};
    for (const q of quotes) {
      map[q.symbol] = {
        name: q.shortName ?? q.symbol,
        price: q.regularMarketPrice ?? null,
        change: q.regularMarketChange ?? null,
        pct: q.regularMarketChangePercent ?? null,
        prev: q.regularMarketPreviousClose ?? null,
        high52: q.fiftyTwoWeekHigh ?? null,
        low52: q.fiftyTwoWeekLow ?? null,
      };
    }

    return new Response(JSON.stringify({ ok: true, data: map, ts: Date.now() }), {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 's-maxage=300, stale-while-revalidate=60',
      },
    });

  } catch (e) {
    // Fallback: v8 spark API
    try {
      const syms = SYMBOLS.join(',');
      const fbRes = await fetch(
        `https://query2.finance.yahoo.com/v8/finance/spark?symbols=${syms}&range=1d&interval=5m`,
        { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } }
      );
      if (!fbRes.ok) throw new Error('fallback 실패');
      const fbJson = await fbRes.json();
      const spark = fbJson?.spark?.result ?? [];

      const map = {};
      for (const item of spark) {
        const sym = item.symbol;
        const meta = item.response?.[0]?.meta ?? {};
        const closes = item.response?.[0]?.indicators?.quote?.[0]?.close ?? [];
        const last = closes.filter(Boolean).at(-1) ?? null;
        const prev = meta.chartPreviousClose ?? null;
        const change = last && prev ? last - prev : null;
        const pct = change && prev ? (change / prev) * 100 : null;
        map[sym] = { name: sym, price: last, change, pct, prev,
          high52: meta.fiftyTwoWeekHigh ?? null, low52: meta.fiftyTwoWeekLow ?? null };
      }

      return new Response(JSON.stringify({ ok: true, data: map, ts: Date.now(), source: 'fallback' }), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 's-maxage=300',
        },
      });
    } catch (e2) {
      return new Response(JSON.stringify({ ok: false, error: e.message, fallbackError: e2.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }
  }
}
