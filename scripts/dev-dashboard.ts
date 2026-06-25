/** dev-dashboard.ts — 대시보드만(러너 없이) 띄워 UI 확인/스크린샷용. 기본 포트 7799(상주 데몬 7788과 분리). */
import { startDashboard } from "../src/dashboard/server.js";
const port = Number(process.env.QUANT_MCP_DASHBOARD_PORT) || 7799;
startDashboard(port).then((d) => console.log("DASH_URL " + d.url)).catch((e) => { console.error(e); process.exit(1); });
