/* 蕃茄鐘聊天機器人（Cloudflare Workers）
 *
 * 網頁關著的時候也能：在 Telegram 收到秘書的提醒、計時結束通知、定時提醒、記帳提醒；
 * 打字記帳（「120 午餐」）、開始／暫停／結束計時。
 *
 * 和網頁讀寫同一份 Firestore 資料（users/{uid}/kv/*、users/{uid}/logs/*），寫法和網頁一樣：
 *   - 每份 kv 文件是 { value: JSON 字串, updatedAt }，寫入時帶「版本前提」，被別人先改了就重讀重做
 *   - 計時狀態比 rev（新的贏）；自動結束的那一段 rev 用預計結束時間，和網頁的 finishPhase 一致，
 *     所以網頁和機器人各結束一次同一段時，記錄（編號＝開始時間_種類）與行程卡（last）都不會重複
 * 機器人自己的資料（連結的聊天室、今天已經送過的提醒等）放在 users/{uid}/bot/state，網頁不會同步它。
 *
 * 需要的設定（wrangler secret / 環境變數）：
 *   TELEGRAM_TOKEN  BotFather 給的權杖
 *   FIREBASE_SA     Firebase 服務帳戶金鑰（整份 JSON）
 *   FIREBASE_UID    你的帳號編號（網頁「秘書」設定裡可以複製）
 *   TIMEZONE        可省略，預設 Asia/Taipei
 * 定時檢查：Cron Trigger 每分鐘一次（wrangler.toml）。
 *
 * 計時規則照抄 script.js（startTimer、stopTimer、endSession、finishPhase、finishCountUp、creditCard），
 * 改網頁的規則時這裡也要一起改。 */

const MODE_LABELS = { focus: '專注', short: '短休息', long: '長休息' };
const MIN_POMODORO_SEC = 5 * 60;
const MIN_LOG_SEC = 10;
const ASK_REPEAT_MIN = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const LATE_LIMIT_MS = 3 * 3600 * 1000; // 超過 3 小時的提醒就不補送（和網頁一樣）
const DOCS = {
    state: 'kv/state', timer: 'kv/timer', schedule: 'kv/schedule', categories: 'kv/categories',
    rewards: 'kv/rewards', reminders: 'kv/reminders', done: 'kv/done', bot: 'bot/state'
};
const KEYBOARD = { keyboard: [[{ text: '開始' }, { text: '暫停' }, { text: '結束' }], [{ text: '任務' }, { text: '狀態' }, { text: '今天' }, { text: '記錄' }, { text: '說明' }]], resize_keyboard: true, is_persistent: true };

/* ---------- 時間（依使用者的時區，不是伺服器的 UTC） ---------- */
let ZONE = 'Asia/Taipei';
let fmt = null;
function parts(ms) {
    if (!fmt || fmt.zone !== ZONE) {
        fmt = new Intl.DateTimeFormat('en-US', { timeZone: ZONE, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' });
        fmt.zone = ZONE;
    }
    const o = {};
    fmt.formatToParts(new Date(ms)).forEach(p => { o[p.type] = p.value; });
    return { date: `${o.year}-${o.month}-${o.day}`, hm: `${o.hour}:${o.minute}`, dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(o.weekday),
             y: +o.year, mo: +o.month, d: +o.day, h: +o.hour, mi: +o.minute, s: +o.second };
}
const dateKey = ms => parts(ms).date;
const hm = ms => parts(ms).hm;
function offsetAt(ms) { const p = parts(ms); return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000; }
// 某一天的「HH:MM」（使用者時區）是哪個時間點
function localTime(date, time) {
    const [y, m, d] = date.split('-').map(Number), [h, mi] = time.split(':').map(Number);
    const guess = Date.UTC(y, m - 1, d, h, mi);
    return guess - offsetAt(guess - offsetAt(guess));
}
function addDays(date, n) { const [y, m, d] = date.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); }
function dowOf(date) { const [y, m, d] = date.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); }
function formatTime(sec) { return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`; }
function durationText(sec) {
    const min = Math.round(sec / 60);
    return min >= 60 ? `${Math.floor(min / 60)} 小時${min % 60 ? ` ${min % 60} 分` : ''}` : `${min} 分鐘`;
}
function money(n) { return `NT$${n < 0 ? '−' : ''}${Math.abs(n).toLocaleString('en-US')}`; }
function newItemId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function cleanTime(v) {
    const m = typeof v === 'string' && v.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const h = Number(m[1]), mi = Number(m[2]);
    return h < 24 && mi < 60 ? `${String(h).padStart(2, '0')}:${m[2]}` : null;
}
function cleanInt(v, min, max, d) { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= min && n <= max ? n : d; }
const clip = (s, n = 18) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/* ---------- Firestore（REST，用服務帳戶登入） ---------- */
let tokenCache = null;
class Conflict extends Error {}

function b64url(bytes) {
    let s = '';
    new Uint8Array(bytes).forEach(b => { s += String.fromCharCode(b); });
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const b64urlText = t => b64url(new TextEncoder().encode(t));

class Store {
    constructor(env) {
        this.sa = typeof env.FIREBASE_SA === 'string' ? JSON.parse(env.FIREBASE_SA) : env.FIREBASE_SA;
        this.root = `projects/${this.sa.project_id}/databases/(default)/documents`;
        this.user = `${this.root}/users/${env.FIREBASE_UID}`;
    }
    async token() {
        if (tokenCache && tokenCache.email === this.sa.client_email && tokenCache.exp > Date.now() + 60000) return tokenCache.value;
        const now = Math.floor(Date.now() / 1000);
        const head = b64urlText(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
        const claim = b64urlText(JSON.stringify({ iss: this.sa.client_email, scope: 'https://www.googleapis.com/auth/datastore', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
        const der = Uint8Array.from(atob(this.sa.private_key.replace(/-----[^-]+-----|\s/g, '')), c => c.charCodeAt(0));
        const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
        const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${head}.${claim}`));
        const res = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${head}.${claim}.${b64url(sig)}`
        });
        const j = await res.json();
        if (!j.access_token) throw new Error(`Google 登入失敗：${JSON.stringify(j).slice(0, 300)}`);
        tokenCache = { value: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000, email: this.sa.client_email };
        return j.access_token;
    }
    async call(path, body) {
        const res = await fetch(`https://firestore.googleapis.com/v1/${path}`, {
            method: 'POST', headers: { Authorization: `Bearer ${await this.token()}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) {
            const status = j.error && j.error.status;
            if (['FAILED_PRECONDITION', 'ABORTED', 'ALREADY_EXISTS', 'NOT_FOUND'].includes(status)) throw new Conflict(status);
            throw new Error(`Firestore ${res.status}：${JSON.stringify(j).slice(0, 300)}`);
        }
        return j;
    }
    // 一次讀好幾份文件：{ 路徑: { value, updateTime } | null }
    async getMany(paths) {
        const j = await this.call(`${this.root}:batchGet`, { documents: paths.map(p => `${this.user}/${p}`) });
        const out = {};
        j.forEach(r => {
            if (!r.found) return;
            const f = r.found.fields || {};
            out[r.found.name.slice(this.user.length + 1)] = { value: f.value ? f.value.stringValue : null, updateTime: r.found.updateTime };
        });
        return out;
    }
    // 開始時間在 since 之後的時間記錄（文件名稱＝開始時間_種類，用名稱排序就是用開始時間排序）
    async logsSince(since) {
        const j = await this.call(`${this.user}:runQuery`, { structuredQuery: {
            from: [{ collectionId: 'logs' }],
            where: { fieldFilter: { field: { fieldPath: '__name__' }, op: 'GREATER_THAN_OR_EQUAL', value: { referenceValue: `${this.user}/logs/${since}` } } }
        } });
        const logs = [];
        j.forEach(r => {
            if (!r.document || !r.document.fields || !r.document.fields.value) return;
            try { logs.push(JSON.parse(r.document.fields.value.stringValue)); } catch (err) {}
        });
        return logs;
    }
    // 開始時間在 [since, until) 之間的時間記錄
    async logsBetween(since, until) {
        const ref = (op, v) => ({ fieldFilter: { field: { fieldPath: '__name__' }, op, value: { referenceValue: `${this.user}/logs/${v}` } } });
        const j = await this.call(`${this.user}:runQuery`, { structuredQuery: {
            from: [{ collectionId: 'logs' }],
            where: { compositeFilter: { op: 'AND', filters: [ref('GREATER_THAN_OR_EQUAL', since), ref('LESS_THAN', until)] } }
        } });
        const logs = [];
        j.forEach(r => {
            if (!r.document || !r.document.fields || !r.document.fields.value) return;
            try { logs.push(JSON.parse(r.document.fields.value.stringValue)); } catch (err) {}
        });
        return logs;
    }
    commit(writes) { return writes.length ? this.call(`${this.root}:commit`, { writes }) : null; }
}

/* 一次處理的工作區：讀進來的文件、要寫回的變動、要送出的訊息。
 * 全部寫入成功後才送訊息；寫入時發現資料被網頁先改了，就整個重做一次。 */
class Ctx {
    constructor(db, now) { this.db = db; this.now = now; this.docs = {}; this.dirty = new Set(); this.newLogs = []; this.logs = null; this.out = []; }
    async load(...names) {
        const need = names.filter(n => !(n in this.docs));
        if (!need.length) return;
        const got = await this.db.getMany(need.map(n => DOCS[n]));
        need.forEach(n => {
            const d = got[DOCS[n]];
            let obj = null;
            try { obj = d && d.value ? JSON.parse(d.value) : null; } catch (err) {}
            this.docs[n] = { raw: d ? d.value : null, updateTime: d ? d.updateTime : null, obj };
        });
    }
    get(n) { if (!this.docs[n]) throw new Error(`沒有先讀取 ${n}`); return this.docs[n].obj; }
    set(n, obj) { this.docs[n].obj = obj; this.dirty.add(n); }
    // 昨天開始到現在的記錄（今天的蕃茄數以結束時間算，跨午夜的那段要算進來）
    async loadLogs(days = 1) {
        if (this.logs && this.logDays >= days) return;
        const since = localTime(addDays(dateKey(this.now), -days), '00:00');
        this.logs = await this.db.logsSince(String(since));
        this.logDays = days;
        this.newLogs.forEach(l => this.logs.push(l));
    }
    addLog(entry) { this.newLogs.push(entry); if (this.logs) this.logs.push(entry); }
    async save() {
        const writes = [];
        this.dirty.forEach(n => {
            const d = this.docs[n];
            const value = JSON.stringify(d.obj);
            if (value === d.raw) return;
            writes.push({
                update: { name: `${this.db.user}/${DOCS[n]}`, fields: { value: { stringValue: value }, updatedAt: { integerValue: String(Date.now()) } } },
                currentDocument: d.updateTime ? { updateTime: d.updateTime } : { exists: false }
            });
        });
        this.newLogs.forEach(l => writes.push({ update: { name: `${this.db.user}/logs/${l.start}_${l.mode}`, fields: { value: { stringValue: JSON.stringify(l) } } } }));
        await this.db.commit(writes);
    }
    say(text, buttons, extra) { this.out.push({ text, buttons, ...extra }); }
}

/* ---------- 讀取各份資料（格式和 script.js 的 clean* 一致） ---------- */
function timerConf(ctx) { return { focus: 1500, short: 300, long: 900, countUp: false, longEvery: 4, autoStart: false, ...(ctx.get('timer') || {}) }; }
function longEvery(T) { const n = Math.round(Number(T.longEvery)); return n >= 2 && n <= 8 ? n : 4; }
function askMinutes(T) { return cleanInt(T.askMin, 0, 600, 90); }
function botOf(ctx) { const b = ctx.get('bot') || {}; ctx.docs.bot.obj = b; return b; }
function touchBot(ctx) { ctx.dirty.add('bot'); return botOf(ctx); }
function stateOf(ctx) {
    let s = ctx.get('state');
    if (!s || !MODE_LABELS[s.mode] || typeof s.timeLeft !== 'number') {
        s = { mode: 'focus', timeLeft: timerConf(ctx).focus, endTime: 0, elapsed: 0, countStart: 0, isRunning: false, session: null, rev: 0 };
        ctx.docs.state.obj = s;
    }
    return s;
}
function saveState(ctx, rev) { const s = stateOf(ctx); s.rev = rev || ctx.now; ctx.set('state', s); }
function scheduleOf(ctx) {
    const raw = ctx.get('schedule');
    const list = Array.isArray(raw) ? raw.filter(t => t && typeof t === 'object' && typeof t.name === 'string' && t.name) : [];
    const seen = {};
    list.forEach(t => { // 舊資料沒有編號時，用和網頁一樣的規則補上
        const n = seen[t.name] = (seen[t.name] || 0) + 1;
        if (!t.id) t.id = `old:${t.name}:${n}`;
    });
    ctx.docs.schedule.obj = list;
    return list;
}
const undone = list => list.filter(t => !t.done);
function categoriesOf(ctx) { const c = ctx.get('categories'); return Array.isArray(c) ? c.filter(x => x && Array.isArray(x.tasks)) : []; }
function taskInfo(ctx, name) {
    for (const c of categoriesOf(ctx)) {
        if (c.tasks.includes(name)) { const m = c.meta && c.meta[name]; return { color: c.color || '#999999', est: m && m.est ? m.est : 1 }; }
    }
    return { color: '#999999', est: 1 };
}
function remindersOf(ctx) {
    const raw = ctx.get('reminders');
    return (Array.isArray(raw) ? raw : []).filter(x => x && x.id && cleanTime(x.time) && x.name)
        .map(x => ({ ...x, time: cleanTime(x.time), days: Array.isArray(x.days) ? x.days : [] }));
}

/* ---------- 秘書設定與語句（和 script.js 的 SEC_DEFAULT、SEC_LINES 一致） ---------- */
const SEC_DEFAULT = { on: true, when: 'hours', ranges: [['09:00', '22:00']], days: [0, 1, 2, 3, 4, 5, 6], idle: 30, tone: 'gentle', review: '21:00', bot: 'telegram', rest: 30, cheer: 30 };
function secConf(T) {
    const raw = T.secretary && typeof T.secretary === 'object' ? T.secretary : {};
    const c = { ...SEC_DEFAULT, ...raw };
    c.on = c.on !== false;
    if (!['hours', 'always', 'open'].includes(c.when)) c.when = 'hours';
    if (!['gentle', 'coach', 'brief'].includes(c.tone)) c.tone = 'gentle';
    if (!['off', 'telegram', 'discord', 'both'].includes(c.bot)) c.bot = 'telegram';
    c.ranges = (Array.isArray(c.ranges) ? c.ranges : []).map(r => Array.isArray(r) ? [cleanTime(r[0]), cleanTime(r[1])] : [null, null]).filter(r => r[0] && r[1]);
    c.days = Array.isArray(c.days) ? c.days.filter(d => Number.isInteger(d) && d >= 0 && d <= 6) : SEC_DEFAULT.days;
    c.idle = cleanInt(c.idle, 5, 600, 30);
    c.rest = cleanInt(c.rest, 0, 600, 30); // 休息多久來關心（0＝不問）
    c.cheer = cleanInt(c.cheer, 0, 600, 30); // 專注多久鼓勵並問在不在（0＝不問）
    c.review = c.review === '' ? '' : (cleanTime(c.review) || '21:00');
    return c;
}
function secInHours(c, now) {
    if (c.when === 'always') return true;
    if (c.when === 'open') return false;
    const p = parts(now), today = p.dow, yesterday = (today + 6) % 7;
    return c.ranges.some(([from, to]) => from <= to
        ? c.days.includes(today) && p.hm >= from && p.hm < to
        : (c.days.includes(today) && p.hm >= from) || (c.days.includes(yesterday) && p.hm < to));
}
const SEC_LINES = {
    gentle: {
        greet: ['嗨，歡迎回來～', '你來了呀，今天也慢慢來就好。', '哈囉，今天過得還好嗎？'],
        idle: ['休息得還好嗎？', '有一陣子沒計時了，還好嗎？', '我在這裡喔，需要的話我們一起開始。'],
        next: ['休息結束了～', '充好電了嗎？'],
        ask: ['要不要做一下「{task}」？先 5 分鐘也可以喔。', '試試「{task}」好嗎？做一點點就好。'],
        none: ['想做點什麼嗎？先選一件小事就好。'],
        resume: ['「{task}」還暫停著，要不要繼續？'],
        praise: ['做得很好！', '辛苦了，真棒～', '又完成一顆了，好厲害！'],
        mini: ['5 分鐘到了，你已經開始了，很棒！要繼續嗎？累了也可以先停。'],
        miniStop: ['有開始就很了不起，休息一下吧，做的時間都記下來了。'],
        rest: ['先休息一下吧。'],
        review: ['今天辛苦了！{stats}早點休息喔。'],
        reviewNone: ['今天好像沒有計時，沒關係，明天再一起試試看。'],
        care: ['已經休息 {min}了，還好嗎？準備好再慢慢回來就好～', '休息 {min}了喔，要不要回來做一點點？'],
        cheer: ['好專心～已經專注 {min}了！', '已經做了 {min}，你真的很棒！'],
        keep: ['你真的很努力！', '好認真，辛苦了～']
    },
    coach: {
        greet: ['來了！今天也一起衝吧！💪', '嘿！準備好了嗎？', '歡迎回來，戰士！'],
        idle: ['休息夠了吧？回來囉！', '嘿，該動起來啦！', '時間在跑喔，我們上吧！'],
        next: ['休息結束！', '電充滿了！'],
        ask: ['下一顆就衝「{task}」吧！', '「{task}」，現在就幹掉它！'],
        none: ['選一件事，馬上開始！'],
        resume: ['「{task}」還沒做完，繼續衝！'],
        praise: ['太強了！🔥', '漂亮！再來一顆！', '完美！手感正熱！'],
        mini: ['5 分鐘完成！手感來了吧？繼續衝？'],
        miniStop: ['OK！5 分鐘也是進步，記下來了！'],
        rest: ['喘口氣，等等再上！'],
        review: ['今日戰績：{stats}明天繼續加油！'],
        reviewNone: ['今天還沒開張！明天拚回來！'],
        care: ['休息 {min}了！該回到戰場囉！', '已經休息 {min}，電應該充滿了吧？'],
        cheer: ['{min}了！狀態超好，繼續衝！🔥', '已經撐 {min}，太強了！'],
        keep: ['耐力驚人！💪', '太猛了！']
    },
    brief: {
        greet: ['歡迎回來。'], idle: ['一陣子沒計時了。'], next: ['休息結束。'], ask: ['下一件：「{task}」。'],
        none: ['要做什麼？'], resume: ['「{task}」暫停中。'], praise: ['完成。'], mini: ['5 分鐘到。繼續？'],
        miniStop: ['已記錄。'], rest: ['休息。'], review: ['今日：{stats}'], reviewNone: ['今天沒有記錄。'], care: ['已休息 {min}。'], cheer: ['已專注 {min}。'], keep: ['']
    }
};
function secLine(ctx, kind, vars = {}) {
    const list = SEC_LINES[secConf(timerConf(ctx)).tone][kind] || SEC_LINES.gentle[kind];
    return list[Math.floor(Math.random() * list.length)].replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? vars[k] : ''));
}

/* ---------- 計時（照抄 script.js） ---------- */
function isCountUp(ctx) { const s = stateOf(ctx); return s.session ? !!s.session.countUp : !!timerConf(ctx).countUp; }
function liveActiveSec(s, now) { return s.session ? Math.round((s.session.activeMs + (s.isRunning ? now - s.session.segStart : 0)) / 1000) : 0; }
function pomodorosOf(l) {
    if (l.mode !== 'focus' || l.actualSec < MIN_POMODORO_SEC) return 0;
    if (!l.countUp) return l.completed ? 1 : 0;
    return Math.min(l.pomodoros || 0, Math.floor(l.actualSec / MIN_POMODORO_SEC));
}
function todayCount(ctx) {
    const today = dateKey(ctx.now);
    return ctx.logs.reduce((sum, l) => sum + (dateKey(l.end) === today ? pomodorosOf(l) : 0), 0);
}
function stopTimer(ctx, now) {
    const s = stateOf(ctx), countUp = isCountUp(ctx);
    if (s.isRunning) {
        if (countUp) s.elapsed = Math.max(0, Math.floor((now - s.countStart) / 1000));
        else s.timeLeft = Math.max(0, Math.ceil((s.endTime - now) / 1000));
        if (s.session) {
            const end = countUp ? now : Math.min(now, s.endTime);
            s.session.activeMs += end - s.session.segStart;
            s.session.lastActive = end;
        }
    }
    s.isRunning = false;
}
function endSession(ctx, completed) {
    const s = stateOf(ctx), se = s.session;
    if (!se) return;
    const actualSec = Math.round(se.activeMs / 1000);
    if ((completed && !se.countUp) || actualSec >= MIN_LOG_SEC) {
        const entry = { start: se.start, end: se.lastActive || se.start, mode: se.mode, task: se.task, plannedSec: se.plannedSec, actualSec, completed };
        if (se.countUp) { entry.countUp = true; entry.pomodoros = se.pomodoros || 0; }
        ctx.addLog(entry);
    }
    s.session = null;
}
function switchMode(ctx, next, now) {
    stopTimer(ctx, now); endSession(ctx, false);
    const s = stateOf(ctx);
    s.mode = next; s.timeLeft = timerConf(ctx)[next]; s.elapsed = 0;
}
// opts.task：指定任務（任務條上有同名、還沒完成的卡就推進那張）；沒指定就用任務條第一張
function startTimer(ctx, opts = {}) {
    const s = stateOf(ctx), T = timerConf(ctx), at = opts.at || ctx.now;
    const countUp = s.session ? !!s.session.countUp : !!T.countUp;
    if (!countUp && s.timeLeft <= 0) s.timeLeft = T[s.mode];
    if (!s.session) {
        let card = null, task = '';
        if (s.mode === 'focus') {
            const list = undone(scheduleOf(ctx));
            if (typeof opts.task === 'string') { task = opts.task; card = list.find(c => c.name === task) || null; }
            else { card = list[0] || null; task = card ? card.name : ''; }
        }
        s.session = { mode: s.mode, task, cardId: card ? card.id : null, start: at, plannedSec: countUp ? 0 : s.timeLeft, activeMs: 0, countUp };
        if (opts.mini) s.session.mini = true;
    }
    s.session.segStart = at;
    if (countUp) s.countStart = at - s.elapsed * 1000;
    else s.endTime = at + s.timeLeft * 1000;
    s.isRunning = true;
}
function creditCard(ctx, cardId, earned, sessionStart, now) {
    if (!cardId || !(earned > 0)) return;
    const list = scheduleOf(ctx);
    const card = list.find(c => c.id === cardId);
    if (!card || card.last === String(sessionStart)) return;
    card.did = Math.min(999, (card.did || 0) + earned);
    card.last = String(sessionStart);
    if (!card.done && card.did >= (card.est || 1)) { // 做滿預估顆數：標記完成並移到最後
        card.done = true; card.doneAt = now;
        list.splice(list.indexOf(card), 1); list.push(card);
    }
    ctx.set('schedule', list);
}
function advancePhase(ctx, completed, earned, now) {
    const s = stateOf(ctx);
    let next = 'focus';
    if (s.mode === 'focus') next = (completed && earned > 0 && todayCount(ctx) % longEvery(timerConf(ctx)) === 0) ? 'long' : 'short';
    switchMode(ctx, next, now);
}
// 倒數時間到（以預計結束時間為準）
function finishPhase(ctx) {
    const s = stateOf(ctx), T = timerConf(ctx), at = s.endTime;
    const finished = s.mode, task = s.session ? s.session.task : '';
    const before = todayCount(ctx);
    const cardId = s.session && s.session.cardId, start = s.session && s.session.start;
    stopTimer(ctx, at); endSession(ctx, true);
    const earned = todayCount(ctx) - before;
    creditCard(ctx, cardId, earned, start, at);
    advancePhase(ctx, true, earned, at);
    if (T.autoStart) startTimer(ctx, { at });
    saveState(ctx, at);
    return { finished, task, earned, auto: !!T.autoStart };
}
// 正數按「結束」：每滿一段專注時長算一顆；endAt 是實際結束的時間（只能改到最後一次開始之後）
function finishCountUp(ctx, endAt) {
    const s = stateOf(ctx), T = timerConf(ctx);
    stopTimer(ctx, ctx.now);
    if (Number.isFinite(endAt) && s.session && s.session.lastActive && endAt < s.session.lastActive) {
        const end = Math.max(endAt, s.session.segStart || s.session.start);
        s.session.activeMs = Math.max(0, s.session.activeMs - (s.session.lastActive - end));
        s.session.lastActive = end;
    }
    const before = todayCount(ctx);
    const cardId = s.session && s.session.cardId, start = s.session && s.session.start;
    const wasFocus = s.mode === 'focus', task = s.session ? s.session.task : '';
    const sec = s.session ? Math.round(s.session.activeMs / 1000) : 0;
    if (wasFocus && s.session) s.session.pomodoros = Math.floor(s.session.activeMs / 1000 / Math.max(T.focus, MIN_POMODORO_SEC));
    endSession(ctx, true);
    const after = todayCount(ctx), earned = after - before;
    creditCard(ctx, cardId, earned, start, ctx.now);
    let next = 'focus';
    if (wasFocus) next = earned && Math.floor(after / longEvery(T)) > Math.floor(before / longEvery(T)) ? 'long' : 'short';
    switchMode(ctx, next, ctx.now);
    saveState(ctx);
    return { wasFocus, task, sec, earned };
}

/* ---------- 秘書：建議做什麼 ---------- */
function candidates(ctx) {
    const names = [];
    const add = n => { if (n && !names.includes(n)) names.push(n); };
    const sched = scheduleOf(ctx);
    undone(sched).forEach(t => add(t.name));
    const dow = parts(ctx.now).dow, inSched = new Set(sched.map(t => t.name));
    categoriesOf(ctx).forEach(c => c.tasks.forEach(t => { // 今天的固定任務
        const m = c.meta && c.meta[t];
        if (m && Array.isArray(m.repeat) && m.repeat.includes(dow) && !inSched.has(t)) add(t);
    }));
    [...ctx.logs].filter(l => l.mode === 'focus' && l.task).sort((a, b) => b.start - a.start).forEach(l => add(l.task));
    categoriesOf(ctx).forEach(c => c.tasks.forEach(add));
    return names.slice(0, 6);
}
async function prepSuggest(ctx) { await ctx.load('schedule', 'categories'); await ctx.loadLogs(2); }
// kind：idle（一陣子沒計時）、next（休息結束）、rest（休息太久）、ask（使用者說「開始」但沒說做什麼）
function suggest(ctx, kind, opener) {
    const s = stateOf(ctx), bot = touchBot(ctx);
    const pre = opener ? `${opener} ` : '';
    if (s.session && !s.isRunning && s.session.mode === 'focus') {
        ctx.say(pre + secLine(ctx, 'resume', { task: s.session.task || '剛剛那段' }),
            [[['▶ 繼續', 'resume'], ['結束這段', 'end']], [['等一下', 'snooze']]]);
        return;
    }
    const cands = candidates(ctx);
    bot.cands = cands;
    if (!cands.length) {
        ctx.say(`${pre}${secLine(ctx, 'none')}\n傳「開始 任務名稱」給我就會開始計時。`, kind === 'ask' ? null : [[snoozeBtn(kind)]]);
        return;
    }
    const rows = [[[`▶ 開始「${clip(cands[0])}」`, 'go:0'], ['只做 5 分鐘', 'mini:0']]];
    const others = cands.slice(1).map((n, i) => [clip(n, 14), `go:${i + 1}`]);
    for (let i = 0; i < others.length; i += 2) rows.push(others.slice(i, i + 2));
    if (kind !== 'ask') rows.push([snoozeBtn(kind)]);
    ctx.say(pre + secLine(ctx, 'ask', { task: cands[0] }) + (cands.length > 1 ? '\n或是選別的：' : ''), rows);
}
function snoozeBtn(kind) { return kind === 'rest' ? ['再休息一下', 'rsnz'] : [kind === 'next' ? '再休息一下' : '我在休息', 'snooze']; }
// 「任務」：建議的任務＋任務庫的類別（點類別再列任務）
function showTasks(ctx) {
    const bot = touchBot(ctx), cands = candidates(ctx), cats = categoriesOf(ctx);
    bot.cands = cands;
    const rows = [];
    const two = list => { for (let i = 0; i < list.length; i += 2) rows.push(list.slice(i, i + 2)); };
    two(cands.map((n, i) => [`💡 ${clip(n, 14)}`, `pk:${i}`]));
    two(cats.map((c, i) => [`📚 ${clip(c.title, 10)}（${c.tasks.length}）`, `cat:${i}`]).filter((x, i) => cats[i].tasks.length));
    if (!rows.length) { ctx.say('任務庫是空的。可以到網頁新增任務，或直接傳「開始 任務名稱」。'); return; }
    const notes = ['要做什麼？'];
    if (cands.length) notes.push('💡 是建議（任務條、今天的固定任務、最近做過的）');
    if (cats.length) notes.push('📚 是任務庫的類別，點了看裡面的任務');
    ctx.say(notes.join('\n'), rows);
}
function showCategory(ctx, i) {
    const c = categoriesOf(ctx)[i];
    if (!c || !c.tasks.length) { ctx.say('任務庫已經變了，按「任務」再選一次。'); return; }
    const rows = [];
    const items = c.tasks.slice(0, 40).map((t, j) => [clip(t, 16), `pt:${i}:${j}`]);
    for (let k = 0; k < items.length; k += 2) rows.push(items.slice(k, k + 2));
    rows.push([['‹ 回到任務', 'tasks']]);
    ctx.say(`📚 ${c.title}${c.tasks.length > 40 ? `（只列前 40 個，共 ${c.tasks.length} 個）` : ''}`, rows);
}
// 排進任務條：和網頁一樣，還沒完成的最後一張剛好同名就多排幾顆，否則排在已完成的前面
function addToTaskBar(ctx, name) {
    const list = scheduleOf(ctx), info = taskInfo(ctx, name);
    const open = undone(list), last = open[open.length - 1];
    if (last && last.name === name) last.est = Math.min(12, (last.est || 1) + info.est);
    else {
        const firstDone = list.findIndex(t => t.done);
        list.splice(firstDone < 0 ? list.length : firstDone, 0, { id: newItemId(), name, color: info.color, est: info.est });
    }
    ctx.set('schedule', list);
    const card = undone(list).find(t => t.name === name), pos = undone(list).indexOf(card) + 1;
    const bot = touchBot(ctx);
    bot.pick = name;                            // 「▶ 現在開始」用
    bot.lastAdd = { id: card.id, n: info.est }; // 「取消」用（只能取消最近一次）
    ctx.say(last && last.name === name ? `「${name}」多排了 ${info.est} 顆（共 ${last.est} 顆）。` : `已把「${name}」排進任務條（第 ${pos} 個）。`,
        [[['▶ 現在開始', 'pg'], ['取消', 'pu']]]);
}
// 取消最近一次排進任務條：疊加的就減回去，新加的（還沒做過）就拿掉
function undoAdd(ctx) {
    const bot = touchBot(ctx), add = bot.lastAdd;
    if (!add) { ctx.say('這個按鈕已經過期了，要改的話到網頁上改。'); return; }
    const list = scheduleOf(ctx), card = list.find(c => c.id === add.id);
    if (!card || card.done) { ctx.say('這張已經變了（可能完成或刪掉了），要改的話到網頁上改。'); return; }
    if ((card.est || 1) > add.n) { card.est -= add.n; ctx.say(`已取消，「${card.name}」改回 ${card.est} 顆。`); }
    else if (!card.did) { list.splice(list.indexOf(card), 1); ctx.say(`已把「${card.name}」從任務條拿掉。`); }
    else { ctx.say('這張已經開始做了，要改的話到網頁上改。'); return; }
    bot.lastAdd = null;
    ctx.set('schedule', list);
}
function todayStats(ctx) {
    const today = dateKey(ctx.now);
    let sec = 0, pomo = 0;
    ctx.logs.forEach(l => {
        if (l.mode !== 'focus') return;
        if (dateKey(l.start) === today) sec += l.actualSec;
        if (dateKey(l.end) === today) pomo += pomodorosOf(l);
    });
    const ids = new Set();
    (Array.isArray(ctx.get('done')) ? ctx.get('done') : []).forEach(d => { if (d && Number.isFinite(d.at) && dateKey(d.at) === today) ids.add(d.id); });
    scheduleOf(ctx).forEach(t => { if (t.done && Number.isFinite(t.doneAt) && dateKey(t.doneAt) === today) ids.add(t.id); });
    return { sec, pomo, done: ids.size };
}
function statsText(st) {
    const p = [];
    if (st.sec) p.push(`專注 ${Math.round(st.sec / 60)} 分鐘`);
    if (st.pomo) p.push(`${st.pomo} 顆 🍅`);
    if (st.done) p.push(`完成 ${st.done} 項任務`);
    return p.length ? p.join('、') + '。' : '';
}

/* ---------- 查記錄（時間記錄、完成的任務、支出；和網頁一樣保留一年） ---------- */
const DOW_ZH = ['日', '一', '二', '三', '四', '五', '六'];
function md(date) { const [, m, d] = date.split('-').map(Number); return `${m}/${d}（${DOW_ZH[dowOf(date)]}）`; }
function weekStart(date) { return addDays(date, -((dowOf(date) + 6) % 7)); } // 週一開始
function earliestLogDate(ctx) { return addDays(dateKey(ctx.now), -365); }
// 「昨天」「前天」「3天前」「11/25」「11月25日」「2026-11-25」；空白＝今天
function parseLogDate(q, today) {
    if (!q || /^(今天|today)$/i.test(q)) return today;
    if (/^(昨天|昨日|yesterday)$/i.test(q)) return addDays(today, -1);
    if (/^前天$/.test(q)) return addDays(today, -2);
    let m = q.match(/^(\d{1,3})\s*天前$/);
    if (m) return addDays(today, -Number(m[1]));
    m = q.match(/^(?:(\d{4})\s*[-\/.年]\s*)?(\d{1,2})\s*[-\/.月]\s*(\d{1,2})\s*[日號号]?$/);
    if (!m) return null;
    const mo = Number(m[2]), d = Number(m[3]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    const pad = n => String(n).padStart(2, '0');
    const y = m[1] ? Number(m[1]) : Number(today.slice(0, 4));
    let date = `${y}-${pad(mo)}-${pad(d)}`;
    if (addDays(date, 0) !== date) return null; // 2/30 之類不存在的日子
    if (!m[1] && date > today) date = `${y - 1}-${pad(mo)}-${pad(d)}`; // 沒寫年份又在未來：當成去年
    return date;
}
// 開始時間在 from 那天 00:00 到 to 那天結束之間的記錄（含這次剛寫入、還沒存的）
async function logsOfDays(ctx, from, to) {
    const since = localTime(from, '00:00'), until = localTime(addDays(to, 1), '00:00');
    const logs = await ctx.db.logsBetween(String(since), String(until));
    const seen = new Set(logs.map(l => `${l.start}_${l.mode}`));
    ctx.newLogs.forEach(l => { if (l.start >= since && l.start < until && !seen.has(`${l.start}_${l.mode}`)) logs.push(l); });
    return logs.filter(l => l && Number.isFinite(l.start)).sort((a, b) => a.start - b.start);
}
function doneByDate(ctx) { // 日期 → 那天完成的任務名稱
    const by = {}, ids = new Set();
    const add = (id, name, at) => { if (!Number.isFinite(at) || ids.has(id)) return; ids.add(id); (by[dateKey(at)] = by[dateKey(at)] || []).push(name || '（沒有名稱）'); };
    (Array.isArray(ctx.get('done')) ? ctx.get('done') : []).forEach(d => d && add(d.id, d.name, d.at));
    scheduleOf(ctx).forEach(t => { if (t.done) add(t.id, t.name, t.doneAt); });
    return by;
}
function expensesOn(r, date) { return r.expenses.filter(x => Number.isFinite(x.at) && dateKey(x.at) === date).sort((a, b) => a.at - b.at); }
function navRow(prev, next) { return [prev, next].filter(Boolean); }
async function showDay(ctx, date) {
    const today = dateKey(ctx.now), first = earliestLogDate(ctx);
    if (date > today) { ctx.say('那天還沒到喔 😄'); return; }
    if (date < first) { ctx.say('記錄只保留一年，更早的查不到了。'); return; }
    await ctx.load('done', 'rewards');
    // 前一天開始、跨過午夜的那段也要算進這天的蕃茄（和網頁一樣，蕃茄看結束時間、分鐘看開始時間）
    const logs = await logsOfDays(ctx, addDays(date, -1), date);
    const focus = logs.filter(l => l.mode === 'focus');
    let sec = 0, pomo = 0;
    focus.forEach(l => { if (dateKey(l.start) === date) sec += l.actualSec || 0; if (dateKey(l.end) === date) pomo += pomodorosOf(l); });
    // 前一天開始、這天才結束而且有蕃茄的那段也列出來，清單才對得上總數
    const lines = focus.filter(l => dateKey(l.start) === date || (dateKey(l.end) === date && pomodorosOf(l))).map(l => {
        const p = pomodorosOf(l), tags = [], before = dateKey(l.start) !== date;
        if (l.manual) tags.push('補登');
        else if (!l.countUp && !l.completed) tags.push('中斷');
        if (before) tags.push('分鐘算前一天');
        else if (p && dateKey(l.end) !== date) tags.push('蕃茄算隔天');
        return `${before ? '前一天 ' : ''}${hm(l.start)}–${hm(l.end)} ${clip(l.task || '未指定任務', 20)} ${Math.round((l.actualSec || 0) / 60)} 分${p ? ' ' + (p > 1 ? `🍅×${p}` : '🍅') : ''}${tags.length ? `（${tags.join('、')}）` : ''}`;
    });
    const s = stateOf(ctx);
    if (s.session && s.session.mode === 'focus' && dateKey(s.session.start) === date) {
        const live = liveActiveSec(s, ctx.now);
        sec += live;
        lines.push(`${hm(s.session.start)}– ${clip(s.session.task || '未指定任務', 20)} 已 ${Math.round(live / 60)} 分（${s.isRunning ? '進行中' : '暫停中'}）`);
    }
    const done = doneByDate(ctx)[date] || [];
    const r = rewardsOf(ctx), accounts = accountsOf(r), ex = expensesOn(r, date);
    const more = (list, n, unit) => (list.length > n ? [`……還有 ${list.length - n} ${unit}`] : []);
    const out = [`📅 ${md(date)}${date === today ? '今天' : ''}的記錄`];
    const sum = statsText({ sec, pomo, done: done.length });
    out.push(sum ? `🍅 ${sum}` : '這天沒有專注記錄。');
    if (lines.length) out.push('', '⏱ 專注', ...lines.slice(0, 60), ...more(lines, 60, '段'));
    if (done.length) out.push('', '✅ 完成的任務', ...done.slice(0, 40).map(n => `・${clip(n, 30)}`), ...more(done, 40, '項'));
    if (ex.length) {
        out.push('', `💸 支出 共 ${money(ex.reduce((a, x) => a + (x.amount || 0), 0))}`);
        ex.slice(0, 40).forEach(x => { const acc = accounts.find(a => a.id === x.acc); out.push(`・${hm(x.at)} ${clip(x.name || '', 20)} ${money(x.amount || 0)}${acc ? `（${clip(acc.name, 8)}）` : ''}`); });
        out.push(...more(ex, 40, '筆'));
    }
    const prev = addDays(date, -1), next = addDays(date, 1);
    ctx.say(out.join('\n'), [
        navRow(prev >= first && ['◀ 前一天', `lg:${prev}`], next <= today && ['後一天 ▶', `lg:${next}`]),
        [['這一週', `lw:${date}`]]
    ].filter(row => row.length));
}
async function showWeek(ctx, mon) {
    const today = dateKey(ctx.now), first = earliestLogDate(ctx), sun = addDays(mon, 6);
    if (mon > today) { ctx.say('那週還沒到喔 😄'); return; }
    if (sun < first) { ctx.say('記錄只保留一年，更早的查不到了。'); return; }
    await ctx.load('done', 'rewards');
    const logs = await logsOfDays(ctx, addDays(mon, -1), sun);
    const done = doneByDate(ctx), r = rewardsOf(ctx), s = stateOf(ctx);
    const out = [`📅 ${md(mon)} ～ ${md(sun)} 這週的記錄`, ''];
    let tSec = 0, tPomo = 0, tDone = 0, tSpent = 0;
    const dayBtns = [];
    for (let i = 0; i < 7; i++) {
        const d = addDays(mon, i);
        if (d > today) break;
        let sec = 0, pomo = 0;
        logs.forEach(l => { if (l.mode !== 'focus') return; if (dateKey(l.start) === d) sec += l.actualSec || 0; if (dateKey(l.end) === d) pomo += pomodorosOf(l); });
        if (s.session && s.session.mode === 'focus' && dateKey(s.session.start) === d) sec += liveActiveSec(s, ctx.now);
        const nDone = (done[d] || []).length;
        const spent = expensesOn(r, d).reduce((a, x) => a + (x.amount || 0), 0);
        tSec += sec; tPomo += pomo; tDone += nDone; tSpent += spent;
        const p = [];
        if (sec) p.push(`${Math.round(sec / 60)} 分`);
        if (pomo) p.push(`🍅${pomo}`);
        if (nDone) p.push(`✓${nDone}`);
        if (spent) p.push(`💸${money(spent)}`);
        out.push(`${md(d)}${d === today ? '今天' : ''}　${p.length ? p.join('　') : '—'}`);
        if (d >= first) dayBtns.push([DOW_ZH[dowOf(d)], `lg:${d}`]);
    }
    const sum = statsText({ sec: tSec, pomo: tPomo, done: tDone });
    out.push('', sum ? `合計：${sum}` : '這週沒有專注記錄。');
    if (tSpent) out.push(`💸 支出共 ${money(tSpent)}`);
    if (dayBtns.length) out.push('', '點下面的星期幾，看那天的逐筆記錄。');
    const prev = addDays(mon, -7), next = addDays(mon, 7);
    ctx.say(out.join('\n'), [
        dayBtns,
        navRow(addDays(prev, 6) >= first && ['◀ 上一週', `lw:${prev}`], next <= today && ['下一週 ▶', `lw:${next}`])
    ].filter(row => row.length));
}

/* ---------- 記帳（格式和 script.js 的獎勵資料一致） ---------- */
function parseExpense(text) {
    const t = String(text || '').trim();
    const nums = [...t.matchAll(/\d[\d,]*(?:\.\d+)?/g)];
    if (!nums.length) return null;
    const pick = nums.reduce((a, b) => (Number(b[0].replace(/,/g, '')) > Number(a[0].replace(/,/g, '')) ? b : a));
    const amount = Math.round(Number(pick[0].replace(/,/g, '')));
    if (!(amount >= 1 && amount <= 1e9)) return null;
    const name = (t.slice(0, pick.index) + ' ' + t.slice(pick.index + pick[0].length))
        .replace(/NT\$|\$|元|塊/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
    return { amount, name: name || '支出' };
}
function rewardsOf(ctx) {
    const r = ctx.get('rewards') && typeof ctx.get('rewards') === 'object' ? ctx.get('rewards') : {};
    ['deposits', 'grants', 'expenses', 'transfers'].forEach(k => { if (!Array.isArray(r[k])) r[k] = []; });
    ctx.docs.rewards.obj = r;
    return r;
}
function accountsOf(r) {
    if (Array.isArray(r.accounts)) return r.accounts.filter(a => a && a.id);
    return r.fund && typeof r.fund === 'object' ? [{ id: 'fun', name: '娛樂', base: 0 }] : [];
}
function accountBalance(ctx, r, accId) {
    let b = 0;
    r.deposits.forEach(x => { if (x.acc === accId) b += x.amount || 0; });
    r.grants.forEach(x => { if (x.acc === accId) b += x.amount || 0; });
    r.expenses.forEach(x => { if (x.acc === accId) b -= x.amount || 0; });
    r.transfers.forEach(x => { if (x.from === accId) b -= x.amount || 0; if (x.to === accId) b += x.amount || 0; });
    Object.values(r.archive || {}).forEach(m => { const v = m && m[accId]; if (Array.isArray(v)) b += (v[0] || 0) + (v[1] || 0) - (v[2] || 0) + (v[3] || 0) - (v[4] || 0); });
    if (accId === 'fun') Object.values(r.days || {}).forEach(v => { b += ((v && v.d) || 0) - ((v && v.x) || 0); });
    return b;
}
// 每月底薪（編號含月份，網頁和機器人各發一次也只算一次）
function grantBaseSalaries(ctx, r) {
    const month = dateKey(ctx.now).slice(0, 7);
    (Array.isArray(r.accounts) ? r.accounts : []).forEach(a => {
        const id = `b:${a.id}:${month}`;
        if (!a.base || r.grants.some(g => g.id === id)) return;
        r.grants.push({ id, at: ctx.now, acc: a.id, amount: a.base });
    });
}
function expenseReply(ctx, r, x) {
    const accounts = accountsOf(r), acc = accounts.find(a => a.id === x.acc) || { id: x.acc, name: '帳戶' };
    const left = accountBalance(ctx, r, acc.id);
    const rows = [];
    const others = accounts.filter(a => a.id !== acc.id).map(a => [`改記到「${clip(a.name, 8)}」`, `ea:${x.id}:${accounts.indexOf(a)}`]);
    for (let i = 0; i < others.length; i += 2) rows.push(others.slice(i, i + 2));
    rows.push([['取消這筆', `ex:${x.id}`]]);
    ctx.say(`已記下：${x.name} ${money(x.amount)}，「${acc.name}」${left < 0 ? `透支 ${money(-left)}` : `剩 ${money(left)}`}`, rows);
}
async function addExpense(ctx, p) {
    await ctx.load('rewards');
    const r = rewardsOf(ctx), accounts = accountsOf(r), bot = touchBot(ctx);
    if (!accounts.length) { ctx.say('還沒有帳戶。先到網頁的「⭐ 獎勵」設定帳戶，之後就能在這裡記帳。'); return; }
    const acc = accounts.find(a => a.id === bot.lastExpAcc) || accounts[0];
    grantBaseSalaries(ctx, r);
    const x = { id: newItemId(), at: ctx.now, acc: acc.id, name: p.name, amount: p.amount };
    r.expenses.push(x);
    ctx.set('rewards', r);
    expenseReply(ctx, r, x);
}

/* ---------- 指令 ---------- */
const HELP = [
    '我是你的蕃茄鐘秘書 🍅 可以這樣跟我說：',
    '・開始：開始專注（沒說做什麼的話，我會建議）',
    '・開始 寫報告：直接開始做「寫報告」',
    '・暫停／繼續／結束',
    '・休息：開始休息',
    '・120 午餐：記一筆支出（記到上次用的帳戶，可以再改）',
    '・任務：看建議和任務庫，點了可以開始或排進任務條',
    '・在看直播：把「看直播」排進任務條（開頭打「在」）',
    '・狀態：現在在做什麼',
    '・今天：今天的成績',
    '・記錄：今天的逐筆記錄（也可以「記錄 昨天」「記錄 11/25」「記錄 本週」「記錄 上週」）',
    '',
    '網頁關著的時候，我也會在你設定的時段來關心你、提醒計時結束和定時提醒。'
].join('\n');

async function prepTimer(ctx) { await ctx.load('state', 'timer', 'schedule', 'bot'); await ctx.loadLogs(); }
// 倒數已經到時間、還沒被結束的，先結束（網頁關著時，時間到了要等這裡處理）
function catchUp(ctx) {
    const s = stateOf(ctx);
    const results = [];
    for (let i = 0; i < 6 && s.isRunning && !isCountUp(ctx) && s.endTime && s.endTime <= ctx.now; i++) results.push(finishPhase(ctx));
    return results;
}
function statusLine(ctx) {
    const s = stateOf(ctx), now = ctx.now, se = s.session;
    const count = `今天 ${todayCount(ctx)} 顆 🍅`;
    if (!se) return s.mode === 'focus' ? `目前沒在計時。${count}` : `☕ 輪到${MODE_LABELS[s.mode]}，還沒開始。${count}`;
    const label = se.countUp ? (se.mode === 'focus' ? '自由專注' : '自由休息') : MODE_LABELS[se.mode];
    const what = se.mode === 'focus' ? `${label}「${se.task || '未指定任務'}」` : label;
    if (s.isRunning) {
        return se.countUp ? `▶ ${what}中，${hm(se.start)} 開始，已經 ${durationText(liveActiveSec(s, now))}。${count}`
            : `▶ ${what}中，${hm(s.endTime)} 結束（還剩 ${Math.max(1, Math.ceil((s.endTime - now) / 60000))} 分鐘）。${count}`;
    }
    return `⏸ ${what}暫停中（${se.countUp ? `已經 ${durationText(liveActiveSec(s, now))}` : `剩 ${formatTime(s.timeLeft)}`}）。${count}`;
}
function statusButtons(ctx) {
    const s = stateOf(ctx);
    if (s.session && s.isRunning) return [[['⏸ 暫停', 'pause'], ['⏹ 結束', 'end']]];
    if (s.session) return [[['▶ 繼續', 'resume'], ['⏹ 結束', 'end']]];
    if (s.mode !== 'focus') return [[['☕ 開始休息', 'brk'], ['不休息，開始做事', 'skipbrk']]];
    return [[['▶ 開始', 'sg']]];
}
// 開始專注做某件事；正在專注別的事就不搶
function startFocus(ctx, task, mini) {
    const s = stateOf(ctx);
    if (s.session && s.session.mode === 'focus') {
        if (!s.isRunning && (task == null || task === s.session.task)) { startTimer(ctx); saveState(ctx); ctx.say(`▶ 繼續「${s.session.task || '未指定任務'}」`, statusButtons(ctx)); return; }
        ctx.say(`現在${s.isRunning ? '正在' : '暫停中的是'}「${s.session.task || '未指定任務'}」。要換的話先傳「結束」。`, statusButtons(ctx));
        return;
    }
    if (s.mode !== 'focus') switchMode(ctx, 'focus', ctx.now); // 休息中（或輪到休息）：直接開始做事
    startTimer(ctx, { task: task == null ? undefined : task, mini });
    saveState(ctx);
    const se = stateOf(ctx).session;
    const what = se.task ? `「${se.task}」` : '（未指定任務）';
    ctx.say(se.countUp ? `▶ 開始${mini ? '只做 5 分鐘：' : '專注'}${what}，結束時傳「結束」給我。`
        : `▶ 開始${mini ? '只做 5 分鐘：' : '專注'}${what}，${hm(stateOf(ctx).endTime)} 結束。`, statusButtons(ctx));
}
function endNow(ctx, endAt) {
    const s = stateOf(ctx);
    if (!s.session) { ctx.say(`現在沒有在計時。${statusLine(ctx)}`); return; }
    if (isCountUp(ctx)) {
        const r = finishCountUp(ctx, endAt);
        const after = r.wasFocus ? `已結束，記下 ${durationText(r.sec)}${r.earned ? `，算 ${r.earned} 顆 🍅` : '（不到一顆蕃茄）'}。今天 ${todayCount(ctx)} 顆 🍅` : '休息結束。';
        ctx.say(after, r.wasFocus ? [[['☕ 開始休息', 'brk'], ['不休息，繼續', 'skipbrk']]] : [[['▶ 開始做事', 'sg']]]);
        return;
    }
    // 倒數中途結束：和網頁的「跳過」一樣，這一段記成中斷，切到下一段
    const wasFocus = s.mode === 'focus';
    const sec = liveActiveSec(s, ctx.now);
    advancePhase(ctx, false, 0, ctx.now);
    saveState(ctx);
    ctx.say(wasFocus ? `已結束（做了 ${durationText(sec)}，倒數沒做完不算蕃茄）。` : '休息結束。',
        wasFocus ? [[['☕ 開始休息', 'brk'], ['不休息，繼續', 'skipbrk']]] : [[['▶ 開始做事', 'sg']]]);
}
function pauseNow(ctx) {
    const s = stateOf(ctx);
    if (!s.session || !s.isRunning) { ctx.say(`現在沒有在計時。${statusLine(ctx)}`); return; }
    stopTimer(ctx, ctx.now); saveState(ctx);
    ctx.say(`⏸ 已暫停。${statusLine(ctx)}`, statusButtons(ctx));
}
function startBreak(ctx) {
    const s = stateOf(ctx);
    if (s.session && s.session.mode === 'focus') { ctx.say('還在專注中，要休息的話先傳「結束」。', statusButtons(ctx)); return; }
    if (s.session && s.isRunning) { ctx.say(statusLine(ctx), statusButtons(ctx)); return; }
    if (s.mode === 'focus') switchMode(ctx, 'short', ctx.now);
    startTimer(ctx); saveState(ctx);
    const st = stateOf(ctx);
    ctx.say(st.session.countUp ? '☕ 開始休息，休息好了傳「開始」。' : `☕ 開始${MODE_LABELS[st.mode]}，${hm(st.endTime)} 結束。`, statusButtons(ctx));
}

async function onText(ctx, text) {
    const t = text.trim().replace(/^\/(\w+)(@\w+)?/, (m, c) => ({ help: '說明', status: '狀態', today: '今天', pause: '暫停', resume: '繼續', stop: '結束', focus: '開始', rest: '休息', tasks: '任務', log: '記錄' }[c] || m));
    let m;
    if (/^(說明|幫助|help|\?|？)$/i.test(t)) { ctx.say(HELP, null, { keyboard: true }); return; }
    if ((m = t.match(/^開始\s*(.*)$/s))) {
        await prepTimer(ctx); catchUp(ctx);
        const task = m[1].trim().slice(0, 200);
        const s = stateOf(ctx);
        if (task) { startFocus(ctx, task); return; }
        if (s.session) { startFocus(ctx); return; }                       // 暫停中的：繼續
        if (undone(scheduleOf(ctx)).length) { startFocus(ctx); return; } // 任務條有任務：做第一張
        await prepSuggest(ctx); suggest(ctx, 'ask');
        return;
    }
    if (/^(繼續|resume)$/i.test(t)) { await prepTimer(ctx); catchUp(ctx); startFocusOrResume(ctx); return; }
    if (/^(暫停|pause)$/i.test(t)) { await prepTimer(ctx); catchUp(ctx); pauseNow(ctx); return; }
    if (/^(結束|停|停止|stop)$/i.test(t)) { await prepTimer(ctx); catchUp(ctx); endNow(ctx); return; }
    if (/^休息$/.test(t)) { await prepTimer(ctx); catchUp(ctx); startBreak(ctx); return; }
    if (/^(狀態|現在|status)$/i.test(t)) { await prepTimer(ctx); catchUp(ctx); ctx.say(statusLine(ctx), statusButtons(ctx)); return; }
    if (/^(任務|任務庫|tasks)$/i.test(t)) { await prepTimer(ctx); await prepSuggest(ctx); showTasks(ctx); return; }
    if (/^(今天|today)$/i.test(t)) {
        await prepTimer(ctx); await ctx.load('done', 'rewards'); catchUp(ctx);
        const st = todayStats(ctx);
        const r = rewardsOf(ctx), today = dateKey(ctx.now);
        const ex = r.expenses.filter(x => Number.isFinite(x.at) && dateKey(x.at) === today);
        const spent = ex.length ? `\n💸 今天記了 ${ex.length} 筆支出，共 ${money(ex.reduce((a, x) => a + (x.amount || 0), 0))}。` : '';
        ctx.say((statsText(st) ? `今天：${statsText(st)}` : '今天還沒有專注記錄。') + spent);
        return;
    }
    if ((m = t.match(/^(?:記錄|紀錄|log)(?:\s+|$)(.*)$/is))) {
        const q = m[1].trim(), today = dateKey(ctx.now);
        await prepTimer(ctx); catchUp(ctx);
        if (/^(本週|本周|這週|這周|這禮拜|week)$/i.test(q)) { await showWeek(ctx, weekStart(today)); return; }
        if (/^(上週|上周|上禮拜)$/.test(q)) { await showWeek(ctx, addDays(weekStart(today), -7)); return; }
        const date = parseLogDate(q, today);
        if (!date) { ctx.say('看不懂是哪一天 😅 可以傳「記錄」「記錄 昨天」「記錄 11/25」「記錄 本週」。'); return; }
        await showDay(ctx, date);
        return;
    }
    // 「在看直播」「正在看直播」：把「看直播」排進任務條（開頭的「在」就是記號，所以比記帳先判斷）
    if ((m = t.match(/^(?:正在|在)\s*(.+)$/s))) {
        await prepTimer(ctx); await ctx.load('categories'); catchUp(ctx);
        addToTaskBar(ctx, m[1].trim().slice(0, 200));
        return;
    }
    const p = parseExpense(t);
    if (p) { await ctx.load('bot'); await addExpense(ctx, p); return; }
    ctx.say('我看不太懂 😅 傳「說明」看看可以怎麼跟我說。');
}
function startFocusOrResume(ctx) {
    const s = stateOf(ctx);
    if (s.session && !s.isRunning) { startTimer(ctx); saveState(ctx); ctx.say(`▶ 繼續。${statusLine(ctx)}`, statusButtons(ctx)); return; }
    ctx.say(statusLine(ctx), statusButtons(ctx));
}

async function onButton(ctx, data) {
    const [cmd, a, b] = data.split(':');
    await prepTimer(ctx); catchUp(ctx);
    const bot = touchBot(ctx);
    if (cmd === 'go' || cmd === 'mini') {
        const task = (bot.cands || [])[Number(a)];
        if (task == null) { ctx.say('這個按鈕已經過期了，傳「開始」再選一次。'); return; }
        startFocus(ctx, task, cmd === 'mini');
    } else if (cmd === 'resume') startFocusOrResume(ctx);
    else if (cmd === 'pause') pauseNow(ctx);
    else if (cmd === 'end') endNow(ctx);
    else if (cmd === 'cu') {
        const s = stateOf(ctx);
        if (!s.session || !isCountUp(ctx)) { ctx.say(statusLine(ctx)); return; }
        endNow(ctx, Number(a) ? Number(a) * 60000 : undefined);
    } else if (cmd === 'still' || cmd === 'cont') ctx.say(cmd === 'still' ? '好，繼續加油！做完記得傳「結束」。' : '好，繼續加油！');
    else if (cmd === 'ministop') {
        const s = stateOf(ctx);
        if (!s.session || !s.session.mini) { ctx.say(statusLine(ctx)); return; }
        stopTimer(ctx, ctx.now); endSession(ctx, false);
        s.timeLeft = timerConf(ctx)[s.mode]; s.elapsed = 0;
        saveState(ctx);
        bot.snoozeUntil = ctx.now + secConf(timerConf(ctx)).idle * 60000;
        ctx.say(secLine(ctx, 'miniStop'));
    } else if (cmd === 'brk') startBreak(ctx);
    else if (cmd === 'skipbrk' || cmd === 'sg') {
        const s = stateOf(ctx);
        if (s.session && s.isRunning) { ctx.say(statusLine(ctx), statusButtons(ctx)); return; }
        if (cmd === 'skipbrk' && s.mode !== 'focus' && !s.session) { switchMode(ctx, 'focus', ctx.now); saveState(ctx); }
        await prepSuggest(ctx); suggest(ctx, 'ask');
    } else if (cmd === 'snooze') {
        bot.snoozeUntil = ctx.now + secConf(timerConf(ctx)).idle * 60000;
        if (bot.rest) bot.rest.at = Math.max(bot.rest.at || 0, bot.snoozeUntil); // 休息的關心也晚一點
        ctx.say('好，等等再來找你～');
    } else if (cmd === 'rsnz') { // 休息太久的關心：再休息一下
        const rest = secConf(timerConf(ctx)).rest || 30;
        bot.snoozeUntil = Math.max(bot.snoozeUntil || 0, ctx.now + rest * 60000);
        if (bot.rest && bot.rest.n < REST_MAX) { bot.rest.at = ctx.now + rest * 60000; ctx.say(`好，好好休息～ ${rest} 分鐘後再來看看你。`); }
        else ctx.say('好，好好休息～');
    } else if (cmd === 'rs' || cmd === 'ra') {
        await ctx.load('reminders', 'categories');
        const rem = remindersOf(ctx).find(r => r.id === a);
        if (!rem) { ctx.say('找不到這個提醒了。'); return; }
        // 和網頁的提醒「開始」一樣：把提醒的任務（和接著的任務）放到任務條最上面
        const list = scheduleOf(ctx);
        const add = (name, at) => { const i = taskInfo(ctx, name); const card = { id: newItemId(), name, color: i.color, est: i.est }; list.splice(at, 0, card); return card; };
        add(rem.name, 0);
        if (rem.next) add(rem.next, 1);
        ctx.set('schedule', list);
        if (cmd === 'rs') startFocus(ctx, rem.name);
        else ctx.say(`已把「${rem.name}」${rem.next ? `和「${rem.next}」` : ''}排到任務條最上面。`);
    } else if (cmd === 'tasks') { await prepSuggest(ctx); showTasks(ctx); }
    else if (cmd === 'cat') { await prepSuggest(ctx); showCategory(ctx, Number(a)); }
    else if (cmd === 'pk' || cmd === 'pt') {
        await prepSuggest(ctx);
        const c = categoriesOf(ctx)[Number(a)];
        const name = cmd === 'pk' ? (bot.cands || [])[Number(a)] : c && c.tasks[Number(b)];
        if (name == null) { ctx.say('任務庫已經變了，按「任務」再選一次。'); return; }
        bot.pick = name;
        ctx.say(`「${name}」要怎麼做？`, [[['▶ 開始', 'pg'], ['只做 5 分鐘', 'pm']], [['排進任務條', 'pa']]]);
    } else if (cmd === 'pg' || cmd === 'pm' || cmd === 'pa') {
        if (!bot.pick) { ctx.say('這個按鈕已經過期了，按「任務」再選一次。'); return; }
        if (cmd === 'pa') { await ctx.load('categories'); addToTaskBar(ctx, bot.pick); }
        else startFocus(ctx, bot.pick, cmd === 'pm');
    } else if (cmd === 'pu') undoAdd(ctx);
    else if (cmd === 'lg' || cmd === 'lw') {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(a || '')) { ctx.say('這個按鈕已經過期了，傳「記錄」再看一次。'); return; }
        if (cmd === 'lg') await showDay(ctx, a); else await showWeek(ctx, weekStart(a));
    }
    else if (cmd === 'ea' || cmd === 'ex') {
        await ctx.load('rewards');
        const r = rewardsOf(ctx), x = r.expenses.find(e => e.id === a);
        if (!x) { ctx.say('找不到這筆支出了（可能已經在網頁上刪除）。'); return; }
        if (cmd === 'ex') {
            r.expenses.splice(r.expenses.indexOf(x), 1);
            ctx.set('rewards', r);
            ctx.say(`已取消：${x.name} ${money(x.amount)}`);
            return;
        }
        const acc = accountsOf(r)[Number(b)];
        if (!acc) { ctx.say('找不到這個帳戶了。'); return; }
        x.acc = acc.id; bot.lastExpAcc = acc.id;
        ctx.set('rewards', r);
        expenseReply(ctx, r, x);
    }
}

/* ---------- 每分鐘的檢查（網頁關著時由這裡負責） ---------- */
/* ---------- 休息太久的關心 ---------- */
const REST_MAX = 3; // 一段休息最多關心幾次
// 記下這段休息從什麼時候開始（bot.rest = {from, n：已關心幾次, at：下次最早幾點}）：
// 休息中＝那一段的開始；輪到休息還沒開始＝專注結束的時候；休息結束後還沒開始做事就沿用；開始專注就清掉
function trackRest(ctx) {
    const s = stateOf(ctx), se = s.session, bot = botOf(ctx);
    const old = bot.rest ? bot.rest.from : null;
    let from = old;
    if (se) from = se.mode === 'focus' ? null : se.start;
    else if (s.mode !== 'focus') from = s.rev || ctx.now; // 輪到休息＝剛做完一段專注，rev 是那時候
    if (from !== old) touchBot(ctx).rest = from ? { from, n: 0 } : null;
}
// 正數休息時已經問過「還在休息嗎」：算一次關心，下次延後
function restAsked(ctx, c) {
    trackRest(ctx);
    const r = touchBot(ctx).rest;
    if (r && c.rest) { r.n = Math.min(REST_MAX, r.n + 1); r.at = ctx.now + c.rest * 60000; }
}

async function tick(ctx) {
    await ctx.load('state', 'timer', 'reminders', 'bot');
    const bot = botOf(ctx);
    if (!bot.tg || !bot.tg.chat) return; // 還沒連結 Telegram
    const T = timerConf(ctx), c = secConf(T), now = ctx.now, today = dateKey(now);
    const send = c.bot === 'telegram' || c.bot === 'both';
    const s = stateOf(ctx);
    let spoke = false;
    const fired = bot.fired && bot.fired.date === today ? bot.fired : { date: today, ids: [] };
    const fire = id => { if (fired.ids.includes(id)) return false; fired.ids.push(id); touchBot(ctx).fired = fired; return true; };
    trackRest(ctx); // 先記下現在這一段（下面可能會把它結束掉）

    // 1. 倒數時間到
    if (s.isRunning && !isCountUp(ctx) && s.endTime && s.endTime <= now) {
        await ctx.load('schedule', 'categories'); await ctx.loadLogs(2);
        const results = catchUp(ctx);
        const last = results[results.length - 1];
        if (send && last) {
            spoke = true;
            const st = stateOf(ctx);
            if (last.finished === 'focus') {
                let text = `${c.on ? secLine(ctx, 'praise') : '專注結束！'} 今天第 ${todayCount(ctx)} 顆 🍅。`;
                if (last.auto) ctx.say(`${text}已自動開始${MODE_LABELS[st.mode]}（${hm(st.endTime)} 結束）。`);
                else ctx.say(`${text}${c.on ? secLine(ctx, 'rest') : `接下來是${MODE_LABELS[st.mode]}。`}`, [[['☕ 開始休息', 'brk'], ['不休息，繼續', 'skipbrk']]]);
            } else if (last.auto) ctx.say(`休息結束，下一顆蕃茄開始了！（${hm(st.endTime)} 結束）`);
            else if (c.on) suggest(ctx, 'next', secLine(ctx, 'next'));
            else ctx.say('休息結束，準備開始下一顆蕃茄！', [[['▶ 開始', 'sg']]]);
        }
    }
    // 2. 只做 5 分鐘：滿 5 分鐘問要不要繼續
    const se = stateOf(ctx).session;
    if (se && se.mini && !se.miniAsked && stateOf(ctx).isRunning && liveActiveSec(stateOf(ctx), now) >= 300) {
        se.miniAsked = true; saveState(ctx);
        if (send) { spoke = true; ctx.say(secLine(ctx, 'mini'), [[['繼續做下去', 'cont'], ['先到這裡', 'ministop']]]); }
    }
    // 3. 正數太久：問還在做嗎（和網頁一樣：超過設定的分鐘數，之後每 30 分鐘）
    const first = askMinutes(T);
    if (first && se && stateOf(ctx).isRunning && se.countUp) {
        const sec = liveActiveSec(stateOf(ctx), now), min = Math.floor(sec / 60);
        const step = Math.floor((min - first) / ASK_REPEAT_MIN);
        if (min >= first && !(se.asked != null && se.asked >= step)) {
            se.asked = step; saveState(ctx);
            if (send) {
                spoke = true;
                const focus = se.mode === 'focus', from = se.segStart || se.start;
                // 按鈕上寫幾點就算到幾點（cu:分鐘數時間戳；0＝按下的時候）
                const opts = [['結束，算到現在', 'cu:0']];
                [30, 60].forEach(n => { const t = now - n * 60000; if (t >= from) opts.push([`算到 ${hm(t)}`, `cu:${Math.floor(t / 60000)}`]); });
                const keep = focus && c.on ? secLine(ctx, 'keep') : '';
                ctx.say(`⏱ ${keep ? `${keep}` : ''}已經${focus ? '專注' : '休息'} ${durationText(sec)}了，還在${focus ? '做' : '休息'}嗎？`,
                    [[['還在', 'still'], ['先暫停', 'pause']], opts]);
                if (!focus) restAsked(ctx, c); // 已經問過休息的事，關心延後一輪
                else if (c.cheer) se.cheered = Math.max(se.cheered || 0, Math.floor(min / c.cheer)); // 這則就算這一輪的鼓勵
            }
        }
    }
    // 3b. 專注中：每 c.cheer 分鐘鼓勵一下、問還在不在。機器人自己剛問過「還在做嗎」就不重複；
    // 網頁開著時「還在做嗎」是網頁問的（session.asked 已經記了），Telegram 這邊照樣要鼓勵
    const sc = stateOf(ctx).session;
    if (c.on && c.cheer && !spoke && sc && sc.mode === 'focus' && stateOf(ctx).isRunning) {
        const min = Math.floor(liveActiveSec(stateOf(ctx), now) / 60), k = Math.floor(min / c.cheer);
        if (k >= 1 && k > (sc.cheered || 0)) {
            sc.cheered = k; saveState(ctx);
            if (send) {
                spoke = true;
                ctx.say(`💪 ${secLine(ctx, 'cheer', { min: durationText(k * c.cheer * 60) })}還在嗎？`, [[['還在', 'still'], ['先暫停', 'pause'], ['結束', 'end']]]);
            }
        }
    }
    // 4. 定時提醒
    remindersOf(ctx).forEach(rem => {
        const on = rem.days.length ? rem.days.includes(dowOf(today)) : rem.date === today;
        if (!on) return;
        const at = localTime(today, rem.time);
        if (now < at || !fire(rem.id) || now - at > LATE_LIMIT_MS || !send) return;
        spoke = true;
        ctx.say(`⏰ ${rem.time} ${rem.name}${rem.next ? `，接著${rem.next}` : ''}`, [[['▶ 現在開始', `rs:${rem.id}`], ['排進任務條', `ra:${rem.id}`]]]);
    });
    // 5. 每天記帳提醒（''＝關閉，沒設定＝21:00）
    const expTime = T.expRemind === '' ? null : (cleanTime(T.expRemind) || '21:00');
    if (expTime && now >= localTime(today, expTime) && !fired.ids.includes('__expense')) {
        fire('__expense');
        await ctx.load('rewards');
        const r = rewardsOf(ctx);
        if (send && accountsOf(r).length && now - localTime(today, expTime) <= LATE_LIMIT_MS) {
            spoke = true;
            const n = r.expenses.filter(x => Number.isFinite(x.at) && dateKey(x.at) === today).length;
            ctx.say(`${n ? `💸 今天記了 ${n} 筆支出，還有漏記的嗎？` : '💸 今天有花錢嗎？記一下吧'}\n直接傳「金額 用途」給我就能記，例如：120 午餐`);
        }
    }
    trackRest(ctx);
    if (!c.on || !send) return;
    // 6. 晚上的回顧
    if (c.review && now >= localTime(today, c.review) && !fired.ids.includes('__review')) {
        fire('__review');
        if (now - localTime(today, c.review) <= LATE_LIMIT_MS) {
            await ctx.load('schedule', 'done'); await ctx.loadLogs();
            const st = statsText(todayStats(ctx));
            ctx.say(st ? secLine(ctx, 'review', { stats: st }) : secLine(ctx, 'reviewNone'));
            spoke = true;
        }
    }
    if (spoke || c.when === 'open' || !secInHours(c, now)) return;
    // 7. 休息太久：從休息開始每隔 c.rest 分鐘關心一次，最多 REST_MAX 次（按「再休息一下」等按鈕會延後 rest.at）
    const r = bot.rest;
    if (c.rest && r && r.n < REST_MAX && now >= Math.max(r.from + c.rest * 60000 * (r.n + 1), r.at || 0)) {
        const b = touchBot(ctx);
        if (now - r.from > c.rest * 60000 * (REST_MAX + 1)) { b.rest.n = REST_MAX; return; } // 錯過太久（例如時段外）就不補問
        b.rest.n++; b.rest.at = now + c.rest * 60000;
        b.lastNudge = now; b.snoozeUntil = b.rest.at; // 下面的「一陣子沒計時」不要緊接著再問
        await prepSuggest(ctx);
        suggest(ctx, 'rest', secLine(ctx, 'care', { min: durationText((now - r.from) / 1000) }));
        return;
    }
    // 8. 一陣子沒計時：建議做什麼。沒回應的話下次隔久一點（最多 4 小時）
    if (stateOf(ctx).isRunning || now < (bot.snoozeUntil || 0)) return;
    const st = stateOf(ctx);
    const lastActive = Math.max(st.rev || 0, (st.session && st.session.lastActive) || 0, bot.lastActive || 0);
    if (now - lastActive < c.idle * 60000) return;
    const b = touchBot(ctx);
    b.nudges = lastActive > (b.lastNudge || 0) ? 0 : (b.nudges || 0) + 1;
    b.lastNudge = now;
    b.snoozeUntil = now + Math.min(c.idle * 60000 * 2 ** b.nudges, 4 * 3600 * 1000);
    await prepSuggest(ctx);
    suggest(ctx, 'idle', secLine(ctx, 'idle'));
}

/* ---------- Telegram ---------- */
// 權杖前後多貼的空白、換行不算
function tgToken(env) { return String(env.TELEGRAM_TOKEN || '').trim(); }
async function tg(env, method, body) {
    const res = await fetch(`https://api.telegram.org/bot${tgToken(env)}/${method}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const j = await res.json().catch(() => ({}));
    if (!j.ok) console.error('[telegram]', method, JSON.stringify(j).slice(0, 300));
    return j;
}
function tgMarkup(m) {
    if (m.buttons) return { inline_keyboard: m.buttons.map(row => row.map(([text, data]) => ({ text, callback_data: data }))) };
    return KEYBOARD; // 沒有訊息按鈕時都附上輸入框下面的按鈕（舊的按鈕排列也會跟著更新）
}
async function sendAll(env, chat, msgs) {
    for (const m of msgs) await tg(env, 'sendMessage', { chat_id: chat, text: m.text, reply_markup: tgMarkup(m) });
}
async function webhookSecret(env) {
    const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`pomodoro-webhook:${tgToken(env)}`));
    return [...new Uint8Array(h)].slice(0, 24).map(b => b.toString(16).padStart(2, '0')).join('');
}

// 處理一次：讀資料 → 做事 → 寫回（被網頁先改了就重做）→ 送訊息
async function run(env, fn) {
    const db = new Store(env);
    for (let attempt = 0; ; attempt++) {
        const ctx = new Ctx(db, Date.now());
        await fn(ctx);
        try { await ctx.save(); return ctx; } catch (err) {
            if (!(err instanceof Conflict) || attempt >= 3) throw err;
        }
    }
}

async function onTelegram(env, update) {
    const msg = update.message, cb = update.callback_query;
    const chat = msg ? msg.chat : cb && cb.message && cb.message.chat;
    if (!chat) return;
    let target = null, replyKeyboard = false;
    const ctx = await run(env, async (ctx) => {
        await ctx.load('bot');
        const bot = botOf(ctx);
        target = null;
        if (update.update_id <= (bot.lastUpdate || 0)) return; // Telegram 重送的同一則
        const linked = bot.tg && bot.tg.chat;
        if (!linked) {
            // 第一個在私訊裡傳 /start 的人連結成主人（建立機器人後馬上去傳就好）
            if (msg && chat.type === 'private' && /^\/start\b/.test(msg.text || '')) {
                touchBot(ctx).tg = { chat: chat.id, linkedAt: ctx.now };
                ctx.say(`連結好了！之後我只聽你的 😊\n\n${HELP}`, null, { keyboard: true });
                target = chat.id;
            } else { target = chat.id; ctx.say('請先私訊我「/start」完成連結。'); }
            touchBot(ctx).lastUpdate = update.update_id;
            return;
        }
        if (chat.id !== bot.tg.chat) { target = chat.id; ctx.say('這是私人的蕃茄鐘機器人。'); return; }
        target = chat.id;
        const b = touchBot(ctx);
        b.lastUpdate = update.update_id;
        b.lastActive = ctx.now;
        if (msg) {
            const text = msg.text || '';
            if (/^\/start\b/.test(text)) { ctx.say(`你好！${HELP}`, null, { keyboard: true }); return; }
            if (/^\/unlink\b/.test(text)) { delete b.tg; ctx.say('已解除連結。要重新連結請再傳「/start」。'); return; }
            await onText(ctx, text);
        } else await onButton(ctx, cb.data || '');
    });
    if (cb) {
        await tg(env, 'answerCallbackQuery', { callback_query_id: cb.id });
        // 按過的按鈕收起來，避免重複按
        if (cb.message) await tg(env, 'editMessageReplyMarkup', { chat_id: chat.id, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [] } });
    }
    if (target) await sendAll(env, target, ctx.out);
}

async function setupPage(env, origin) {
    const rows = [];
    const ok = (good, text) => rows.push(`<li class="${good ? 'ok' : 'bad'}">${good ? '✅' : '❌'} ${text}</li>`);
    let botName = '', linked = false, problem = false;
    if (!env.TELEGRAM_TOKEN) { ok(false, '還沒設定 TELEGRAM_TOKEN'); problem = true; }
    let sa = null;
    try { sa = JSON.parse(env.FIREBASE_SA || ''); ok(!!(sa.client_email && sa.private_key), 'Firebase 服務帳戶金鑰'); } catch (err) { ok(false, '還沒設定 FIREBASE_SA，或內容不是完整的 JSON'); problem = true; }
    if (!env.FIREBASE_UID) { ok(false, '還沒設定 FIREBASE_UID（網頁「💬 秘書」設定裡可以複製）'); problem = true; }
    if (!problem) {
        try {
            const db = new Store(env);
            const got = await db.getMany([DOCS.timer, DOCS.bot]);
            ok(!!got[DOCS.timer], got[DOCS.timer] ? '讀得到你的蕃茄鐘資料' : '連上 Firebase 了，但找不到這個帳號的資料（FIREBASE_UID 對嗎？）');
            try { linked = !!JSON.parse(got[DOCS.bot].value).tg.chat; } catch (err) {}
        } catch (err) { ok(false, `讀不到 Firebase：${String(err.message).replace(/[<>&]/g, '')}`); }
        const me = await tg(env, 'getMe', {});
        botName = me.ok ? me.result.username : '';
        ok(!!botName, botName ? `Telegram 機器人 @${botName}` : `TELEGRAM_TOKEN 不對（Telegram 回覆：${String(me.description || me.error_code || '沒有回應').replace(/[<>&]/g, '')}；權杖長得像 1234567890:AAH…，中間有冒號）`);
        if (botName) {
            const wh = await tg(env, 'setWebhook', { url: `${origin}/telegram`, secret_token: await webhookSecret(env), allowed_updates: ['message', 'callback_query'] });
            ok(!!wh.ok, wh.ok ? '已設定好接收 Telegram 訊息' : '設定接收訊息失敗');
            await tg(env, 'setMyCommands', { commands: [
                { command: 'status', description: '現在在做什麼' }, { command: 'focus', description: '開始專注' },
                { command: 'pause', description: '暫停' }, { command: 'stop', description: '結束' },
                { command: 'tasks', description: '建議和任務庫' }, { command: 'today', description: '今天的成績' }, { command: 'help', description: '說明' }
            ] });
            ok(linked, linked ? '已經連結你的 Telegram' : `還沒連結：打開 <a href="https://t.me/${botName}">t.me/${botName}</a>，按「開始」或傳 /start`);
        }
    }
    const html = `<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>蕃茄鐘機器人</title><style>body{font-family:system-ui,sans-serif;max-width:560px;margin:40px auto;padding:0 16px;line-height:1.7}li{list-style:none;margin:6px 0}.bad{color:#b3261e}</style>
<h1>🍅 蕃茄鐘機器人</h1><ul>${rows.join('')}</ul><p>每次更新設定後重新整理這一頁就會重新檢查。</p></html>`;
    return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

export default {
    async fetch(request, env) {
        ZONE = env.TIMEZONE || 'Asia/Taipei';
        const url = new URL(request.url);
        if (request.method === 'POST' && url.pathname === '/telegram') {
            if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== await webhookSecret(env)) return new Response('forbidden', { status: 403 });
            const update = await request.json().catch(() => null);
            // 出錯也回 200：不然 Telegram 會一直重送同一則
            if (update) {
                try { await onTelegram(env, update); } catch (err) {
                    console.error(err);
                    const chat = (update.message && update.message.chat.id) || (update.callback_query && update.callback_query.message && update.callback_query.message.chat.id);
                    if (chat) await tg(env, 'sendMessage', { chat_id: chat, text: '😵 出了點問題，請稍後再試一次。' }).catch(() => {});
                }
            }
            return new Response('ok');
        }
        if (request.method === 'GET' && url.pathname === '/') return setupPage(env, url.origin);
        return new Response('not found', { status: 404 });
    },
    async scheduled(event, env, ectx) {
        ZONE = env.TIMEZONE || 'Asia/Taipei';
        let chat = null;
        const ctx = await run(env, async (ctx) => { await tick(ctx); const b = ctx.get('bot'); chat = b && b.tg && b.tg.chat; });
        if (chat && ctx.out.length) await sendAll(env, chat, ctx.out);
    }
};

// 給本機測試用
export const _test = { parseExpense, localTime, dateKey, parts, secConf, Ctx, Store, onTelegram, tick, run };
