export interface Env {
  VPN_KV: KVNamespace;
  PROBER_SECRET: string;
}

export interface CleanNode {
  ip: string;
  hostname: string;
  country: string;
  countryShort: string;
  ping: number;
  speed: number;
  cleanipScore: number;
  ippureScore: number;
  ispOrg: string;
  openvpnConfig: string;
  checkedAt: number;
}

interface KvPayload {
  updatedAt: number;
  nodes: CleanNode[];
  historyCache: Record<string, {
    isResidential: boolean;
    cleanipScore: number;
    ippureScore: number;
    ispOrg: string;
    checkedAt: number;
  }>;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const auth = request.headers.get("Authorization");

    // 1. 供 GitHub Actions 读写状态 (单次 KV 读写)
    if (url.pathname === "/api/state") {
      if (!env.PROBER_SECRET || auth !== `Bearer ${env.PROBER_SECRET}`) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      if (request.method === "GET") {
        const data = await env.VPN_KV.get("STATE_DATA", "json");
        return Response.json(data || { updatedAt: 0, nodes: [], historyCache: {} });
      }
      if (request.method === "POST") {
        const body = await request.text();
        await env.VPN_KV.put("STATE_DATA", body);
        return Response.json({ status: "ok" });
      }
    }

    const state = (await env.VPN_KV.get("STATE_DATA", "json")) as KvPayload | null;
    const nodes = state?.nodes || [];
    const updatedAt = state?.updatedAt || 0;

    // 2. 公开 JSON API
    if (url.pathname === "/api/ips") {
      return Response.json({ updatedAt, count: nodes.length, nodes });
    }

    // 3. 在线 HTML 看板
    return renderHtml(nodes, updatedAt);
  }
};

function renderHtml(nodes: CleanNode[], updatedAt: number): Response {
  const updatedMins = updatedAt ? Math.max(0, Math.floor((Date.now() / 1000 - updatedAt) / 60)) : -1;
  const badge = (s: number) => s <= 15
    ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/30"
    : "bg-amber-500/20 text-amber-400 border-amber-500/30";

  const rows = nodes.map(r => `
    <tr class="border-b border-slate-800 hover:bg-slate-800/40 transition">
      <td class="p-4 font-mono text-sky-400 font-medium">${r.ip}</td>
      <td class="p-4"><span class="px-2 py-1 bg-slate-800 rounded text-xs mr-2">${r.countryShort}</span>${r.country}</td>
      <td class="p-4 text-slate-300 text-sm truncate max-w-[220px]" title="${r.ispOrg}">${r.ispOrg}</td>
      <td class="p-4"><span class="px-2.5 py-1 rounded-full text-xs border ${badge(r.cleanipScore)}">CleanIP: ${r.cleanipScore}</span></td>
      <td class="p-4"><span class="px-2.5 py-1 rounded-full text-xs border ${badge(r.ippureScore)}">IPPure: ${r.ippureScore}</span></td>
      <td class="p-4 text-slate-300 text-sm">${(r.speed / 1000000).toFixed(1)} Mbps / ${r.ping} ms</td>
      <td class="p-4">
        <a href="data:application/x-openvpn-profile;base64,${r.openvpnConfig}" download="${r.countryShort}_${r.ip}.ovpn"
           class="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded text-xs font-medium transition">
          下载 .ovpn
        </a>
      </td>
    </tr>`).join("");

  const html = `<!DOCTYPE html>
<html lang="zh-CN" class="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>VPN Gate 纯净家宽实时看板</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-950 text-slate-100 min-h-screen p-6 md:p-10">
  <div class="max-w-7xl mx-auto">
    <div class="flex flex-col md:flex-row justify-between items-start md:items-center mb-8 gap-4">
      <div>
        <h1 class="text-2xl font-bold tracking-tight">VPN Gate 纯净家宽节点监控</h1>
        <p class="text-slate-400 text-sm mt-1">OpenVPN + SOCKS5 隧道实测 · CleanIP & IPPure 双重免认证自检 (${updatedMins >= 0 ? `${updatedMins} 分钟前更新` : "等待首次同步"})</p>
      </div>
      <div class="flex items-center gap-3">
        <span class="px-3 py-1.5 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 rounded-lg text-sm">
          可用纯净家宽: <strong>${nodes.length}</strong> 个
        </span>
        <a href="/api/ips" target="_blank" class="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 rounded-lg text-sm transition">JSON</a>
      </div>
    </div>
    <div class="bg-slate-900/70 border border-slate-800 rounded-xl overflow-x-auto shadow-xl">
      <table class="w-full text-left border-collapse">
        <thead>
          <tr class="border-b border-slate-800 text-slate-400 text-xs uppercase">
            <th class="p-4">出口 IP</th>
            <th class="p-4">国家/地区</th>
            <th class="p-4">ISP 运营商</th>
            <th class="p-4">CleanIP 风险值</th>
            <th class="p-4">IPPure 风险值</th>
            <th class="p-4">带宽 / 延迟</th>
            <th class="p-4">配置导出</th>
          </tr>
        </thead>
        <tbody>
          ${rows || `<tr><td colspan="7" class="p-8 text-center text-slate-500">暂无数据，请等待 GitHub Actions 完成首轮拨测推送...</td></tr>`}
        </tbody>
      </table>
    </div>
  </div>
</body>
</html>`;

  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}