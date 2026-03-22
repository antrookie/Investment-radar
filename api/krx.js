export const config = { maxDuration: 30 };

// KRX 내부 API 엔드포인트
// 공매도 잔고: http://data.krx.co.kr/comm/bldAttendant/getJsonData.cmd
// 신용거래: 한국금융투자협회(KOFIA) 데이터 활용

const KRX_BASE = 'http://data.krx.co.kr/comm/bldAttendant/getJsonData.cmd';

// 오늘 날짜 및 전주 날짜 계산
function getDateStr(daysAgo = 0) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  // 주말이면 금요일로 조정
  if (d.getDay() === 0) d.setDate(d.getDate() - 2);
  if (d.getDay() === 6) d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

async function fetchKrxShortSelling() {
  const trdDd = getDateStr(1); // 어제 기준

  // KOSPI 공매도 잔고 상위
  const body = new URLSearchParams({
    bld: 'dbms/MDC/STAT/standard/MDCSTAT30301',
    mktId: 'STK', // KOSPI
    trdDd,
    share: '1',
    money: '1',
    csvxls_isNo: 'false',
  });

  const res = await fetch(KRX_BASE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': 'http://data.krx.co.kr/contents/MDC/MDI/mdMain/mdMainIdx.cmd',
      'Origin': 'http://data.krx.co.kr',
    },
    body: body.toString(),
  });

  if (!res.ok) throw new Error(`KRX KOSPI 공매도 ${res.status}`);
  return await res.json();
}

async function fetchKrxShortSellingKosdaq() {
  const trdDd = getDateStr(1);

  const body = new URLSearchParams({
    bld: 'dbms/MDC/STAT/standard/MDCSTAT30301',
    mktId: 'KSQ', // KOSDAQ
    trdDd,
    share: '1',
    money: '1',
    csvxls_isNo: 'false',
  });

  const res = await fetch(KRX_BASE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': 'http://data.krx.co.kr/contents/MDC/MDI/mdMain/mdMainIdx.cmd',
      'Origin': 'http://data.krx.co.kr',
    },
    body: body.toString(),
  });

  if (!res.ok) throw new Error(`KRX KOSDAQ 공매도 ${res.status}`);
  return await res.json();
}

// 신용거래: 금융투자협회 KOFIA API
async function fetchCreditBalance() {
  const today = getDateStr(1);
  const weekAgo = getDateStr(8);

  const url = `https://freesis.kofia.or.kr/sisnew/app/FEWebContentView.do` +
    `?menuCode=M_ETC_0060&type=json` +
    `&searchStartDate=${weekAgo}&searchEndDate=${today}`;

  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Accept': 'application/json',
      'Referer': 'https://freesis.kofia.or.kr/',
    },
  });

  if (!res.ok) throw new Error(`KOFIA 신용잔고 ${res.status}`);
  return await res.json();
}

export default async function handler(req, res) {
  const results = await Promise.allSettled([
    fetchKrxShortSelling(),
    fetchKrxShortSellingKosdaq(),
    fetchCreditBalance(),
  ]);

  const [kospiShort, kosdaqShort, credit] = results.map(r =>
    r.status === 'fulfilled' ? r.value : { error: r.reason?.message }
  );

  // KOSPI 공매도 잔고 합산
  let kospiShortBalance = null;
  let kosdaqShortBalance = null;

  try {
    if (kospiShort?.output) {
      const total = kospiShort.output.reduce((sum, row) => {
        const val = parseFloat((row.REMAINDER_AMT ?? '0').replace(/,/g, ''));
        return sum + (isNaN(val) ? 0 : val);
      }, 0);
      kospiShortBalance = Math.round(total / 100000000); // 원 → 억원
    }
  } catch {}

  try {
    if (kosdaqShort?.output) {
      const total = kosdaqShort.output.reduce((sum, row) => {
        const val = parseFloat((row.REMAINDER_AMT ?? '0').replace(/,/g, ''));
        return sum + (isNaN(val) ? 0 : val);
      }, 0);
      kosdaqShortBalance = Math.round(total / 100000000);
    }
  } catch {}

  // 신용융자 잔고
  let creditData = null;
  try {
    if (credit?.result) {
      const latest = credit.result[0];
      creditData = {
        kospi:  latest?.kospiCrdtAmt  ? Math.round(parseFloat(latest.kospiCrdtAmt)  / 100) : null,
        kosdaq: latest?.kosdaqCrdtAmt ? Math.round(parseFloat(latest.kosdaqCrdtAmt) / 100) : null,
        date:   latest?.standardDt ?? null,
      };
    }
  } catch {}

  const data = {
    short_selling: {
      kospi:  kospiShortBalance,
      kosdaq: kosdaqShortBalance,
      date:   getDateStr(1).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3'),
      raw_error: kospiShort?.error ?? null,
    },
    credit: creditData ?? { error: credit?.error ?? '데이터 없음' },
    ts: Date.now(),
  };

  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=300');
  res.setHeader('Access-Control-Allow-Origin', '*');
  return res.status(200).json({ ok: true, data });
}
