/**
 * 自动取货系统 v2 —— 零操作 · 买家自助取货
 * 
 * 卖虚拟商品的卖家装上这个，买家付款后自己来取货，卖家不用管。
 * 替代闲管家（省198元/年）和淘宝自动发货插件（省月费）。
 * 
 * 启动：node server.js
 * 访问：http://localhost:3000
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ===== 配置区 =====
const PORT = 3000;
const ADMIN_PASSWORD = 'admin888';  // 管理员密码
const DATA_DIR = path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
// ==================

// Session管理
const sessions = new Map();

function parseCookies(h) {
    const o = {};
    if (!h) return o;
    h.split(';').forEach(c => { const [k, ...v] = c.trim().split('='); if (k) o[k.trim()] = v.join('='); });
    return o;
}

function readJSON(fn) {
    const fp = path.join(DATA_DIR, fn);
    try { return JSON.parse(fs.readFileSync(fp, 'utf-8')); } catch { return []; }
}
function writeJSON(fn, d) { fs.writeFileSync(path.join(DATA_DIR, fn), JSON.stringify(d, null, 2), 'utf-8'); }

function isAdmin(req) {
    const c = parseCookies(req.headers.cookie);
    if (!c.sid) return false;
    const s = sessions.get(c.sid);
    return s && Date.now() - s.t < 86400000;
}

function json(res, data, status = 200) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
}

function sendFile(res, fp, ct) {
    try {
        const c = fs.readFileSync(fp, 'utf-8');
        res.writeHead(200, { 'Content-Type': ct || 'text/html; charset=utf-8' });
        res.end(c);
    } catch { res.writeHead(404); res.end('Not Found'); }
}

function body(req) {
    return new Promise(r => {
        let d = '';
        req.on('data', c => d += c);
        req.on('end', () => { try { r(JSON.parse(d)); } catch { r({}); } });
    });
}

// ===== HTTP服务 =====
const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = url.pathname;
    const m = req.method;

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (m === 'OPTIONS') { res.writeHead(200); res.end(); return; }

    try {
        // ========== 公共接口 ==========

        // 买家自助取货
        if (m === 'POST' && p === '/api/claim') {
            const b = await body(req);
            const { productName, code } = b;
            if (!productName || !code) {
                return json(res, { ok: false, msg: '请选择商品并输入验证信息' });
            }

            const products = readJSON('products.json');
            const product = products.find(p => p.name === productName);
            if (!product) return json(res, { ok: false, msg: '商品不存在，请联系卖家' });
            if (!product.enabled) return json(res, { ok: false, msg: '该商品已下架' });

            // 验证模式
            const mode = product.verifyMode || 'simple';

            if (mode === 'code') {
                // 取货码模式：输入预生成的取货码验证
                let codes = readJSON('codes.json');
                const record = codes.find(c => c.code === code && c.productId === product.id && !c.used);
                if (!record) return json(res, { ok: false, msg: '取货码无效或已被使用' });
                record.used = true;
                record.usedAt = new Date().toISOString();
                record.ip = req.socket.remoteAddress;
                writeJSON('codes.json', codes);
                // 更新统计
                product.usedCount = (product.usedCount || 0) + 1;
                writeJSON('products.json', products);
                return json(res, { ok: true, link: product.link, extractCode: product.extractCode || '' });
            } else if (mode === 'order') {
                // 订单号模式：输入8位数字验证，首次输入有效
                if (!/^\d{6,12}$/.test(code)) return json(res, { ok: false, msg: '请输入正确的订单号' });
                let claims = readJSON('claims.json');
                const key = product.id + '-' + code;
                if (claims.find(c => c.key === key)) return json(res, { ok: false, msg: '该订单号已被使用' });
                claims.push({ key, productId: product.id, code, time: new Date().toISOString(), ip: req.socket.remoteAddress });
                writeJSON('claims.json', claims);
                product.usedCount = (product.usedCount || 0) + 1;
                writeJSON('products.json', products);
                return json(res, { ok: true, link: product.link, extractCode: product.extractCode || '' });
            } else {
                // 简单模式：直接放行（IP频率限制由前端限制）
                let claims = readJSON('claims.json');
                const ip = req.socket.remoteAddress;
                const today = new Date().toISOString().slice(0, 10);
                const todayClaims = claims.filter(c => c.ip === ip && c.time?.startsWith(today));
                if (todayClaims.length >= 10) return json(res, { ok: false, msg: '今日领取次数已达上限' });

                const key = product.id + '-' + ip + '-' + Date.now();
                claims.push({ key, productId: product.id, code: 'simple-' + Date.now(), time: new Date().toISOString(), ip });
                writeJSON('claims.json', claims);
                product.usedCount = (product.usedCount || 0) + 1;
                writeJSON('products.json', products);
                return json(res, { ok: true, link: product.link, extractCode: product.extractCode || '' });
            }
        }

        // 登录（公开接口，必须在管理员检查之前）
        if (m === 'POST' && p === '/api/login') {
            const b = await body(req);
            if (b.password === ADMIN_PASSWORD) {
                const sid = crypto.randomUUID();
                sessions.set(sid, { t: Date.now() });
                res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': `sid=${sid}; HttpOnly; Path=/; Max-Age=86400` });
                return res.end(JSON.stringify({ ok: true }));
            }
            return json(res, { error: '密码错误' }, 403);
        }

        if (m === 'POST' && p === '/api/logout') {
            const c = parseCookies(req.headers.cookie);
            if (c.sid) sessions.delete(c.sid);
            return json(res, { ok: true });
        }

        if (m === 'GET' && p === '/api/check') {
            return json(res, { isAdmin: isAdmin(req) });
        }

        // 公开商品列表（供取货页下拉）
        if (m === 'GET' && p === '/api/products/public') {
            const products = readJSON('products.json').filter(p => p.enabled !== false);
            return json(res, products.map(p => ({ id: p.id, name: p.name, verifyMode: p.verifyMode || 'simple' })));
        }

        // ========== 静态文件（公开） ==========
        if (!isAdmin(req)) {
            let fp = p === '/' ? path.join(PUBLIC_DIR, 'index.html')
                : p === '/admin' ? path.join(PUBLIC_DIR, 'admin.html')
                : path.join(PUBLIC_DIR, p.slice(1));
            if (fs.existsSync(fp) && fs.statSync(fp).isFile()) {
                const ext = path.extname(fp);
                const mt = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript' };
                return sendFile(res, fp, mt[ext] || 'text/plain');
            }
            // API请求返回401
            if (p.startsWith('/api/')) return json(res, { error: '未登录' }, 401);
            // 否则返回取货页
            return sendFile(res, path.join(PUBLIC_DIR, 'index.html'));
        }

        // ========== 管理员接口（需登录） ==========

        // ===== 商品管理 =====
        if (m === 'GET' && p === '/api/products') return json(res, readJSON('products.json'));

        if (m === 'POST' && p === '/api/products') {
            const b = await body(req);
            if (!b.name || !b.link) return json(res, { error: '名称和链接必填' }, 400);
            const products = readJSON('products.json');
            products.push({
                id: crypto.randomUUID(), name: b.name, link: b.link,
                extractCode: b.extractCode || '', price: b.price || 0,
                verifyMode: b.verifyMode || 'simple', enabled: true,
                createdAt: new Date().toISOString(), usedCount: 0
            });
            writeJSON('products.json', products);
            return json(res, products[products.length - 1]);
        }

        if (m === 'PUT' && p.startsWith('/api/products/')) {
            const id = p.split('/')[3]; const b = await body(req);
            let ps = readJSON('products.json');
            const idx = ps.findIndex(p => p.id === id);
            if (idx === -1) return json(res, { error: '不存在' }, 404);
            Object.assign(ps[idx], b);
            writeJSON('products.json', ps);
            return json(res, ps[idx]);
        }

        if (m === 'DELETE' && p.startsWith('/api/products/')) {
            const id = p.split('/')[3];
            let ps = readJSON('products.json');
            ps = ps.filter(p => p.id !== id);
            writeJSON('products.json', ps);
            return json(res, { ok: true });
        }

        // ===== 取货码管理 =====
        if (m === 'POST' && p === '/api/codes/generate') {
            const b = await body(req);
            if (!b.productId || !b.count) return json(res, { error: '参数不足' }, 400);
            let codes = readJSON('codes.json');
            const products = readJSON('products.json');
            const product = products.find(p => p.id === b.productId);
            if (!product) return json(res, { error: '商品不存在' }, 404);

            const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
            const exist = codes.map(c => c.code);
            const generated = [];
            for (let i = 0; i < b.count; i++) {
                let code;
                do {
                    code = '';
                    for (let j = 0; j < 8; j++) code += chars[crypto.randomInt(chars.length)];
                } while (exist.includes(code));
                exist.push(code);
                const nc = { code, productId: b.productId, productName: product.name, createdAt: new Date().toISOString(), used: false, usedAt: null };
                codes.push(nc);
                generated.push(nc);
            }
            writeJSON('codes.json', codes);
            return json(res, { generated, total: b.count });
        }

        if (m === 'GET' && p === '/api/codes') {
            let codes = readJSON('codes.json');
            const pid = url.searchParams.get('productId');
            const u = url.searchParams.get('used');
            if (pid) codes = codes.filter(c => c.productId === pid);
            if (u === 'true') codes = codes.filter(c => c.used);
            if (u === 'false') codes = codes.filter(c => !c.used);
            codes.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
            return json(res, codes.slice(0, 500));
        }

        if (m === 'DELETE' && p.startsWith('/api/codes/')) {
            let codes = readJSON('codes.json');
            codes = codes.filter(c => c.code !== p.split('/')[3]);
            writeJSON('codes.json', codes);
            return json(res, { ok: true });
        }

        // ===== 订单 / 领取记录 =====
        if (m === 'GET' && p === '/api/claims') {
            const claims = readJSON('claims.json');
            claims.sort((a, b) => new Date(b.time) - new Date(a.time));
            return json(res, claims.slice(0, 500));
        }

        // ===== 统计 =====
        if (m === 'GET' && p === '/api/stats') {
            const products = readJSON('products.json');
            const claims = readJSON('claims.json');
            const codes = readJSON('codes.json');
            const totalUsed = products.reduce((s, p) => s + (p.usedCount || 0), 0);
            const totalRevenue = products.reduce((s, p) => s + (p.usedCount || 0) * (p.price || 0), 0);
            return json(res, {
                totalProducts: products.length, totalClaims: claims.length, totalUsed,
                totalRevenue: Math.round(totalRevenue * 100) / 100,
                codesGenerated: codes.length, codesUsed: codes.filter(c => c.used).length
            });
        }

        // 默认 → index.html
        sendFile(res, path.join(PUBLIC_DIR, 'index.html'));

    } catch (err) {
        console.error('Error:', err);
        json(res, { error: '服务器错误' }, 500);
    }
});

// ===== 初始化 =====
['data', 'public'].forEach(d => { if (!fs.existsSync(path.join(__dirname, d))) fs.mkdirSync(path.join(__dirname, d)); });
['products.json', 'codes.json', 'claims.json'].forEach(f => {
    if (!fs.existsSync(path.join(DATA_DIR, f))) writeJSON(f, []);
});

server.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log('═══════════════════════════════');
    console.log('  自动取货系统 v2 已启动');
    console.log('═══════════════════════════════');
    console.log(`  买家取货页: http://localhost:${PORT}/`);
    console.log(`  管理后台:   http://localhost:${PORT}/admin`);
    console.log(`  管理员密码: ${ADMIN_PASSWORD}`);
    console.log('═══════════════════════════════');
    console.log('  使用方式：');
    console.log('  1. 后台添加商品（名称+网盘链接+验证模式）');
    console.log('  2. 商品描述写：拍下后访问取货页领取');
    console.log('  3. 买家自己输入信息领取，卖家零操作');
    console.log('═══════════════════════════════\n');
});
