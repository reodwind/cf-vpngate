import { spawn, execSync } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import fetch from 'node-fetch';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { debug } from 'console';

const WORKER_URL = (process.env.WORKER_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
const PROBER_SECRET = process.env.PROBER_SECRET || 'Mb6dgy7ooaBF2iosugddP7NA5R39imy3';
const MAX_FRAUD_SCORE = Number(process.env.MAX_FRAUD_SCORE || 35);
const IS_DEBUG = process.env.DEBUG === '1' || process.argv.includes('--debug');
const CONCURRENCY = IS_DEBUG ? 1 : 5; // 本地调试时单线程串行，日志更清晰

console.log('=== 环境变量检查 ===');
console.log('WORKER_URL:', process.env.WORKER_URL ? '已配置 (' + process.env.WORKER_URL + ')' : '❌ 未配置！');
console.log('PROBER_SECRET:', process.env.PROBER_SECRET ? '已配置 (长度: ' + process.env.PROBER_SECRET.length + ')' : '❌ 未配置！');

// 自动查找系统中的 ocproxy 绝对路径 (兼容 Linux /usr/bin 与 macOS Homebrew)
function getOcproxyPath(): string {
	try {
		return execSync('which ocproxy').toString().trim();
	} catch {
		throw new Error('未找到 ocproxy 命令！请先执行 apt install ocproxy 或 brew install ocproxy');
	}
}

const OCPROXY_BIN = getOcproxyPath();

async function main() {
	console.log(`=== 启动模式: ${IS_DEBUG ? '🔧 本地 DEBUG 调试模式 (仅测前 3 个可用节点)' : '🚀 生产批量并发模式'} ===`);
	console.log(`=== 目标 Worker: ${WORKER_URL} | ocproxy 路径: ${OCPROXY_BIN} ===\n`);

	const headers = {
		Authorization: `Bearer ${PROBER_SECRET}`,
		'Content-Type': 'application/json',
		'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
		'Accept-Language': 'zh-CN,zh;q=0.9',
	};

	const now = Math.floor(Date.now() / 1000);

	// 1. 测试与本地/远程 CF Worker 的通信是否正常
	const stateRes = await fetch(`${WORKER_URL}/api/state`, {
		headers: headers,
	});

	if (!stateRes.ok) {
		throw new Error(
			`无法连接 Worker (${WORKER_URL}/api/state)，HTTP ${stateRes.status}。请检查 wrangler dev 是否已启动且 PROBER_SECRET 一致！`,
		);
	}
	const prevState: any = await stateRes.json();
	const historyCache = prevState.historyCache || {};
	console.log(`[1/4] 成功连接 Worker KV，当前历史缓存记录数: ${Object.keys(historyCache).length}`);

	// 2. 拉取 VPN Gate 列表
	console.log(`[2/4] 正在拉取 VPN Gate 节点列表...`);
	const csvRes = await fetch('http://www.vpngate.net/api/iphone/');
	const csvText = await csvRes.text();
	let rawNodes = csvText
		.split('\n')
		.filter((l) => l.trim() && !l.startsWith('*') && !l.startsWith('#'))
		.map((line) => {
			const c = line.split(',');
			return {
				hostname: c[0],
				ip: c[1],
				score: Number(c[2]) || 0,
				ping: Number(c[3]) || 999,
				speed: Number(c[4]) || 0,
				country: c[5],
				countryShort: c[6],
				openvpnConfig: c[14]?.trim() || '',
			};
		})
		.filter((n) => n.ip && n.openvpnConfig);

	if (IS_DEBUG) {
		rawNodes = rawNodes.slice(0, 3); // 本地测试只取前 3 个，30 秒内出结果
		debug(`[DEBUG] 拉取到 ${rawNodes.length} 个可用节点，前 3 个: ${JSON.stringify(rawNodes.slice(0, 3), null, 2)}`);
	}

	console.log(`[3/4] 本轮计划拨测节点数: ${rawNodes.length} 个\n`);
	const validCleanNodes: any[] = [];

	for (let i = 0; i < rawNodes.length; i += CONCURRENCY) {
		const chunk = rawNodes.slice(i, i + CONCURRENCY);
		await Promise.all(
			chunk.map(async (node, idx) => {
				const socksPort = 11080 + idx;
				const cached = historyCache[node.ip];

				if (
					!IS_DEBUG &&
					cached &&
					(!cached.isResidential || cached.cleanipScore > MAX_FRAUD_SCORE || cached.ippureScore > MAX_FRAUD_SCORE)
				) {
					return;
				}

				console.log(`---> [开始拨号] ${node.ip} (${node.countryShort}) | 分配本地代理端口: 127.0.0.1:${socksPort}`);
				const probeRes = await testNodeViaOpenVpn(node.ip, node.openvpnConfig, socksPort);
				if (!probeRes.alive) return;

				historyCache[node.ip] = {
					isResidential: probeRes.isResidential,
					cleanipScore: probeRes.cleanipScore,
					ippureScore: probeRes.ippureScore,
					ispOrg: probeRes.ispOrg,
					checkedAt: now,
				};

				// 在 DEBUG 模式下，哪怕评分超标或非家宽，只要你想看看板效果，也可以加上 process.env.FORCE_SAVE=1 强制写入本地看板
				const forceSave = process.env.FORCE_SAVE === '1';
				if (forceSave || (probeRes.isResidential && probeRes.cleanipScore <= MAX_FRAUD_SCORE && probeRes.ippureScore <= MAX_FRAUD_SCORE)) {
					validCleanNodes.push({
						...node,
						cleanipScore: probeRes.cleanipScore,
						ippureScore: probeRes.ippureScore,
						ispOrg: probeRes.ispOrg,
						checkedAt: now,
					});
				}
			}),
		);
	}

	// 4. 推送回 Worker KV
	const pushRes = await fetch(`${WORKER_URL}/api/state`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${PROBER_SECRET}`,
		},
		body: JSON.stringify({ updatedAt: now, nodes: validCleanNodes, historyCache }),
	});

	console.log(`\n[4/4] 状态回写 Worker 完成 (HTTP ${pushRes.status})！`);
	console.log(`      写入看板的达标节点数: ${validCleanNodes.length} 个`);
	console.log(`      现在可以在浏览器打开 ${WORKER_URL} 查看网页看板效果！`);
}

async function testNodeViaOpenVpn(ip: string, base64Config: string, socksPort: number): Promise<any> {
	const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `vpn-${socksPort}-`));
	const ovpnPath = path.join(tmpDir, 'client.ovpn');

	let ovpnContent = Buffer.from(base64Config, 'base64').toString('utf-8');
	ovpnContent += `\ndata-ciphers AES-256-GCM:AES-128-GCM:CHACHA20-POLY1305:AES-128-CBC:AES-256-CBC\ndata-ciphers-fallback AES-128-CBC\nconnect-retry-max 1\nconnect-timeout 10\n`;
	await fs.writeFile(ovpnPath, ovpnContent);

	return new Promise((resolve) => {
		let done = false;
		const finish = async (res: any) => {
			if (done) return;
			done = true;
			proc.kill('SIGKILL');
			await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
			resolve(res);
		};

		const proc = spawn('openvpn', [
			'--config',
			ovpnPath,
			'--script-security',
			'2',
			'--up',
			`${OCPROXY_BIN} -D ${socksPort}`,
			'--dev',
			'null',
		]);

		const timer = setTimeout(() => {
			console.log(`  [×] ${ip} OpenVPN 握手超时 (22s)`);
			finish({ alive: false });
		}, 22000);

		proc.stdout.on('data', async (chunk: Buffer) => {
			const log = chunk.toString();
			if (IS_DEBUG && (log.includes('Peer Connection Initiated') || log.includes('TLS Error'))) {
				console.log(`  [OpenVPN 日志] ${ip}: ${log.trim().split('\n').pop()}`);
			}

			if (log.includes('Initialization Sequence Completed')) {
				console.log(`  [✓] ${ip} 隧道建立成功，正在通过 socks5h://127.0.0.1:${socksPort} 请求 CleanIP & IPPure...`);
				try {
					await new Promise((r) => setTimeout(r, 500));
					const res = await checkPurityOverSocks(`socks5h://127.0.0.1:${socksPort}`);
					clearTimeout(timer);
					console.log(
						`  [★ 实测结果] ${ip} -> 家宽:${res.isResidential} | CleanIP风险:${res.cleanipScore} | IPPure风险:${res.ippureScore} | ISP:${res.ispOrg}`,
					);
					finish({ alive: true, ...res });
				} catch (err: any) {
					clearTimeout(timer);
					console.log(`  [×] ${ip} SOCKS5 代理请求失败: ${err.message}`);
					finish({ alive: false });
				}
			}
		});

		proc.on('exit', () => {
			clearTimeout(timer);
			finish({ alive: false });
		});
	});
}

async function checkPurityOverSocks(socksUrl: string) {
	const agent = new SocksProxyAgent(socksUrl);

	const [cleanRes, pureRes] = await Promise.all([
		fetch('https://cleanip.io/cli?json=1&lang=en', {
			agent,
			headers: { 'User-Agent': 'curl/8.5.0', Accept: 'application/json, text/plain, */*' },
			timeout: 10000,
		}),
		fetch('https://my.ippure.com/v1/info', {
			agent,
			headers: { 'User-Agent': 'Mozilla/5.0 Chrome/128.0.0.0', Accept: 'application/json' },
			timeout: 10000,
		}),
	]);

	const rawCleanText = (await cleanRes.text()).replace(/\x1b\[[0-9;]*m/g, '').trim();
	const rawPureText = await pureRes.text();

	if (IS_DEBUG) {
		console.log(`  [DEBUG CleanIP 原始响应前200字符]: ${rawCleanText.slice(0, 200).replace(/\n/g, ' ')}`);
		console.log(`  [DEBUG IPPure  原始响应前200字符]: ${rawPureText.slice(0, 200).replace(/\n/g, ' ')}`);
	}

	let cleanipRiskScore = 99;
	let isCleanIpResidential = false;
	let ispOrg = '';

	try {
		const cJson: any = JSON.parse(rawCleanText);
		const d = cJson.data || cJson;
		if (typeof d.risk_score === 'number' || typeof d.fraud_score === 'number') {
			cleanipRiskScore = Number(d.risk_score ?? d.fraud_score);
		} else if (typeof d.purity_score === 'number' || typeof d.cleanliness_score === 'number' || typeof d.score === 'number') {
			const val = Number(d.purity_score ?? d.cleanliness_score ?? d.score);
			cleanipRiskScore = d.purity_score !== undefined || d.cleanliness_score !== undefined ? Math.max(0, 100 - val) : val;
		}
		const netType = String(d.network_type ?? d.asn_type ?? d.ip_type ?? d.type ?? '').toLowerCase();
		const isDc = Boolean(d.is_datacenter || d.is_hosting || d.is_vpn || d.is_proxy || d.is_tor);
		isCleanIpResidential =
			!isDc && (Boolean(d.is_residential) || netType.includes('residential') || netType.includes('isp') || netType.includes('家宽'));
		ispOrg = d.isp || d.asn_org || d.org || '';
	} catch {
		const isDc = /(datacenter|hosting|vpn\s*:\s*yes|proxy\s*:\s*yes|机房)/i.test(rawCleanText);
		const hasRes = /(residential|isp|家庭宽带|住宅|家宽)/i.test(rawCleanText);
		isCleanIpResidential = hasRes && !isDc;

		const riskMatch = rawCleanText.match(/(?:fraud|risk)\s*(?:score)?\s*[:：]\s*(\d{1,3})/i);
		const purityMatch = rawCleanText.match(/(?:purity|cleanliness|clean|score)\s*[:：]\s*(\d{1,3})/i);
		if (riskMatch) cleanipRiskScore = parseInt(riskMatch[1], 10);
		else if (purityMatch) cleanipRiskScore = Math.max(0, 100 - parseInt(purityMatch[1], 10));

		const ispMatch = rawCleanText.match(/(?:ISP|Org|Organization|ASN)\s*[:：]\s*([^\n\r]+)/i);
		if (ispMatch) ispOrg = ispMatch[1].trim();
	}

	const pureData: any = JSON.parse(rawPureText);
	const pObj = pureData.data || pureData;
	const ippureRiskScore = Number(pObj.fraudScore ?? pObj.fraud_score ?? pObj.score ?? 99);
	const pureTypeStr = String(pObj.ipType ?? pObj.usageType ?? pObj.type ?? '').toLowerCase();
	const isIpPureResidential =
		pObj.isResidential === true || pureTypeStr.includes('residential') || pureTypeStr.includes('isp') || pureTypeStr.includes('家宽');

	if (!ispOrg) ispOrg = pObj.asOrganization || pObj.isp || pObj.org || 'ISP';

	return {
		cleanipScore: cleanipRiskScore,
		ippureScore: ippureRiskScore,
		isResidential: isCleanIpResidential && isIpPureResidential,
		ispOrg,
	};
}

main().catch((err) => {
	console.error('\n[❌ 运行报错]:', err.message);
	process.exit(1);
});
