import axios from "axios";

const BASE = "https://contract.mexc.com";
const symbol = process.argv[2] || "CLANKER_USDT";

async function main() {
  try {
    // 1) Contract detail (info about contract)
    const detailRes = await axios.get(`${BASE}/api/v1/contract/detail`, {
      params: { symbol }
    });
    console.log("=== contract detail ===");
    console.log(JSON.stringify(detailRes.data, null, 2));

    // 2) Ticker (24h / last price)
    const tickerRes = await axios.get(`${BASE}/api/v1/contract/ticker/${symbol}`);
    console.log("\n=== ticker ===");
    console.log(JSON.stringify(tickerRes.data, null, 2));

    // 3) Funding rate
    const fundRes = await axios.get(`${BASE}/api/v1/contract/funding_rate/${symbol}`);
    console.log("\n=== funding_rate ===");
    console.log(JSON.stringify(fundRes.data, null, 2));

  } catch (err: any) {
    console.error("Lỗi:", err.response ? err.response.data : err.message);
  }
}

main();
