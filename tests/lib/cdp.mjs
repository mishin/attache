// Минимальный клиент Chrome DevTools Protocol без внешних зависимостей.
// Нужен только для тестов (tests/e2e.mjs) — само приложение им не пользуется.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';

const CHROME_CANDIDATES = [
    process.env.CHROME_PATH,
    'google-chrome',
    'google-chrome-stable',
    'chromium',
    'chromium-browser',
    'microsoft-edge',
    'brave-browser'
].filter(Boolean);

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.txt': 'text/plain; charset=utf-8'
};

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CdpConnection {
    constructor(ws) {
        this.ws = ws;
        this.nextId = 0;
        this.pending = new Map();
        this.handlers = new Map();
        ws.addEventListener('message', (ev) => {
            const raw = typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8');
            const msg = JSON.parse(raw);
            if (msg.id !== undefined) {
                const p = this.pending.get(msg.id);
                if (!p) return;
                this.pending.delete(msg.id);
                if (msg.error) p.reject(new Error(`${msg.error.message} (${msg.error.code})`));
                else p.resolve(msg.result);
                return;
            }
            for (const fn of this.handlers.get(msg.method) || []) fn(msg.params || {}, msg.sessionId);
        });
    }

    send(method, params = {}, sessionId) {
        return new Promise((resolve, reject) => {
            const id = ++this.nextId;
            this.pending.set(id, { resolve, reject });
            try {
                this.ws.send(JSON.stringify({ id, method, params, sessionId }));
            } catch (err) {
                this.pending.delete(id);
                reject(err);
            }
        });
    }

    on(method, fn) {
        if (!this.handlers.has(method)) this.handlers.set(method, []);
        this.handlers.get(method).push(fn);
    }

    /** Ждёт одно событие (опционально — только для нужного sessionId). */
    waitEvent(method, sessionId, timeoutMs = 30000) {
        return new Promise((resolve, reject) => {
            const handler = (params, sid) => {
                if (sessionId && sid !== sessionId) return;
                clearTimeout(timer);
                const arr = this.handlers.get(method);
                arr.splice(arr.indexOf(handler), 1);
                resolve(params);
            };
            const timer = setTimeout(() => {
                const arr = this.handlers.get(method);
                arr.splice(arr.indexOf(handler), 1);
                reject(new Error(`Таймаут ожидания события ${method}`));
            }, timeoutMs);
            this.on(method, handler);
        });
    }
}

export class Page {
    constructor(connection, sessionId) {
        this.connection = connection;
        this.sessionId = sessionId;
        this.console = [];
        this.errors = [];
        connection.on('Runtime.consoleAPICalled', (p, sid) => {
            if (sid !== sessionId) return;
            this.console.push({ type: p.type, text: p.args.map((a) => a.value ?? a.description ?? '').join(' ') });
        });
        connection.on('Runtime.exceptionThrown', (p, sid) => {
            if (sid !== sessionId) return;
            const d = p.exceptionDetails || {};
            this.errors.push(d.exception?.description || d.text || 'exception');
        });
        connection.on('Log.entryAdded', (p, sid) => {
            if (sid !== sessionId) return;
            if (p.entry.level === 'error') this.errors.push(p.entry.text);
        });
    }

    send(method, params = {}) {
        return this.connection.send(method, params, this.sessionId);
    }

    async goto(url) {
        await this.send('Page.enable');
        await this.send('Runtime.enable');
        await this.send('Log.enable');
        const loaded = this.connection.waitEvent('Page.loadEventFired', this.sessionId);
        const res = await this.send('Page.navigate', { url });
        if (res.errorText) throw new Error(`Не удалось открыть ${url}: ${res.errorText}`);
        await loaded;
    }

    /** Выполняет выражение в странице и возвращает значение (ожидает промисы). */
    async eval(expression) {
        const res = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (res.exceptionDetails) {
            const d = res.exceptionDetails;
            throw new Error(`Ошибка в странице: ${d.exception?.description || d.text}`);
        }
        return res.result.value;
    }

    /** Подставляет файлы или папку в <input type="file"> по CSS-селектору. */
    async setFiles(selector, paths) {
        const { root } = await this.send('DOM.getDocument', { depth: 0 });
        const { nodeId } = await this.send('DOM.querySelector', { nodeId: root.nodeId, selector });
        if (!nodeId) throw new Error(`Не найден элемент ${selector}`);
        await this.send('DOM.setFileInputFiles', { nodeId, files: paths });
    }

    async screenshot(filePath) {
        const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
        writeFileSync(filePath, Buffer.from(data, 'base64'));
    }

    clearErrors() {
        this.errors.length = 0;
    }
}

export class Browser {
    constructor(proc, connection, userDataDir) {
        this.proc = proc;
        this.connection = connection;
        this.userDataDir = userDataDir;
    }

    static async launch({ headless = true, width = 1440, height = 900 } = {}) {
        let lastError;
        for (const bin of CHROME_CANDIDATES) {
            const userDataDir = mkdtempSync(join(tmpdir(), 'attache-chrome-'));
            const args = [
                headless ? '--headless=new' : '',
                '--remote-debugging-port=0',
                `--user-data-dir=${userDataDir}`,
                '--no-first-run',
                '--no-default-browser-check',
                '--disable-extensions',
                '--disable-background-networking',
                '--disable-sync',
                '--hide-scrollbars',
                '--mute-audio',
                `--window-size=${width},${height}`,
                'about:blank'
            ].filter(Boolean);
            const proc = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
            try {
                const wsUrl = await new Promise((resolve, reject) => {
                    let buf = '';
                    const timer = setTimeout(() => reject(new Error('Chrome не выдал DevTools URL')), 15000);
                    proc.stderr.on('data', (chunk) => {
                        buf += chunk.toString();
                        const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
                        if (m) { clearTimeout(timer); resolve(m[1]); }
                    });
                    proc.on('exit', (code) => { clearTimeout(timer); reject(new Error(`Chrome завершился с кодом ${code}`)); });
                });
                const ws = new WebSocket(wsUrl);
                await new Promise((resolve, reject) => {
                    ws.addEventListener('open', resolve, { once: true });
                    ws.addEventListener('error', () => reject(new Error('Не удалось подключиться к DevTools')), { once: true });
                });
                return new Browser(proc, new CdpConnection(ws), userDataDir);
            } catch (err) {
                lastError = err;
                try { proc.kill('SIGKILL'); } catch { /* noop */ }
                try { rmSync(userDataDir, { recursive: true, force: true }); } catch { /* noop */ }
            }
        }
        throw new Error(`Не удалось запустить Chrome: ${lastError?.message}`);
    }

    async newPage() {
        const { targetId } = await this.connection.send('Target.createTarget', { url: 'about:blank' });
        const { sessionId } = await this.connection.send('Target.attachToTarget', { targetId, flatten: true });
        return new Page(this.connection, sessionId);
    }

    async close() {
        try { await this.connection.send('Browser.close'); } catch { /* noop */ }
        try { this.proc.kill('SIGKILL'); } catch { /* noop */ }
        await sleep(300);
        try { rmSync(this.userDataDir, { recursive: true, force: true }); } catch { /* noop */ }
    }
}

/** Простейший статический HTTP-сервер для тестов (localhost — secure context). */
export async function startStaticServer(rootDir) {
    const server = createServer((req, res) => {
        try {
            const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
            const filePath = join(rootDir, urlPath === '/' ? '/index.html' : urlPath);
            if (!filePath.startsWith(rootDir)) { res.writeHead(403); res.end(); return; }
            const body = readFileSync(filePath);
            res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
            res.end(body);
        } catch {
            res.writeHead(404);
            res.end('not found');
        }
    });
    await new Promise((resolve, reject) => {
        server.on('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    return {
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((r) => server.close(r))
    };
}
