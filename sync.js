/* --- 雲端同步（Firebase：Google 登入 + Firestore） ---
 * 資料仍以 localStorage 為主，這裡只負責和雲端互相同步：
 *   users/{uid}/kv/{名稱}   任務庫、行程、時長設定、計時狀態，各一份
 *                           任務庫與行程：兩邊都改過時逐項合併（見 script.js 的 mergeStored）
 *                           計時狀態：比版本時間，新的贏；時長設定：以最後寫入為準
 *   users/{uid}/logs/{id}   每筆時間記錄一份，兩台裝置的記錄會合併（今日蕃茄數由記錄算出）
 *
 * 記錄保留一年，可能有幾千筆。為了不要每次開網頁都把全部讀一遍（免費額度有每日讀取上限）：
 *   - 平常只即時監聽最近 LOG_WINDOW_DAYS 天的記錄
 *   - 每隔 FULL_SYNC_DAYS 天（或換帳號時）才完整核對一次全部記錄
 */
import { firebaseConfig } from './firebase-config.js';

const FIREBASE_VERSION = '10.12.2';
const META_KEY = 'pomodoro_sync_meta'; // 同步用的本機資訊：上次登入的帳號、還沒傳上去的項目、已知的雲端記錄
const DAY_MS = 24 * 60 * 60 * 1000;
const LOG_WINDOW_DAYS = 14; // 即時監聽最近幾天的記錄
const FULL_SYNC_DAYS = 7;   // 每隔幾天完整核對一次（必須小於上面的天數，兩次核對之間才不會有漏掉的區間）

const app = window.pomodoroApp;
const K = app.keys;
// 雲端文件名稱 ↔ localStorage key
const KV = { categories: K.categories, schedule: K.schedule, timer: K.timer, state: K.state };
const KV_NAME = Object.fromEntries(Object.entries(KV).map(([name, key]) => [key, name]));

let fb = null;            // 載入後的 Firebase 函式
let auth = null, db = null;
let uid = null;
let unsubscribers = [];
let applying = false;     // 正在把雲端資料寫回本機，這期間的變動不要再傳上去
let pushTimer = null;
let knownRemoteLogs = new Set(); // 這台裝置所知「雲端上有的記錄」，用來分辨是對方新增的還是自己刪掉的
let connected = false;           // 登入後的第一次對齊與監聽是否已經完成
let retryTimer = null;
let status = 'off';

const fab = document.getElementById('syncFab');
const statusEl = document.getElementById('syncStatus');
const signInBtn = document.getElementById('syncSignIn');
const signOutBtn = document.getElementById('syncSignOut');

/* --- 登入門檻 ---
 * 要登入、而且 Firestore 規則允許這個帳號讀取自己的資料，才能使用網頁。
 * 誰能用由 Firebase 的規則決定，這裡不寫死帳號：之後在規則裡開放其他人，他們登入後就能用。
 * 注意這只是擋畫面；真正保護資料的是 Firestore 規則。 */
const gateMsg = document.getElementById('gateMsg');
const gateBtn = document.getElementById('gateSignIn');
const GATE_DEFAULT = '請用 Google 帳號登入後使用。';
let gateNotice = ''; // 下一次回到登入畫面時要顯示的說明（例如這個帳號沒有權限）
function unlock() { document.documentElement.classList.add('unlocked'); }
function lock(msg, canSignIn = true) {
    document.documentElement.classList.remove('unlocked');
    gateMsg.textContent = msg;
    gateBtn.style.display = canSignIn ? '' : 'none';
}

/* --- 本機同步資訊 --- */
function readMeta() {
    try { return { uid: null, dirty: {}, logIds: [], ...JSON.parse(localStorage.getItem(META_KEY) || '{}') }; }
    catch (err) { return { uid: null, dirty: {}, logIds: [] }; }
}
function writeMeta(meta) { localStorage.setItem(META_KEY, JSON.stringify(meta)); }
// 每次標記都換一個版本號：上傳途中又有新修改時，上傳完不會誤把新修改當成已同步
function markDirty(key) {
    const meta = readMeta();
    meta.dirty[key] = `${Date.now()}-${Math.random()}`;
    writeMeta(meta);
}
function clearDirty(key, version) {
    const meta = readMeta();
    if (version === undefined || meta.dirty[key] === version) delete meta.dirty[key];
    writeMeta(meta);
}
// base：每份可合併的資料「上次和雲端一致時的內容」，合併時用來判斷是誰改了什麼
const MERGEABLE = new Set(app.mergeable);
function getBase(key) { const b = readMeta().base; return b && typeof b[key] === 'string' ? b[key] : null; }
function setBase(key, value) {
    if (!MERGEABLE.has(key)) return;
    const meta = readMeta();
    meta.base = meta.base || {};
    if (value === null || value === undefined) delete meta.base[key]; else meta.base[key] = value;
    writeMeta(meta);
}
function rememberLogIds() { const meta = readMeta(); meta.logIds = [...knownRemoteLogs]; writeMeta(meta); }

const logId = l => `${l.start}_${l.mode}`;

/* --- 狀態顯示 --- */
const STATUS_TEXT = {
    off: '尚未登入。登入後，登入同一個 Google 帳號的裝置會自動同步。',
    connecting: '連線中…',
    syncing: '同步中…',
    ok: '已同步',
    offline: '目前離線，恢復連線後會自動上傳',
    error: '同步失敗，請稍後再試'
};
function setStatus(next, detail) {
    status = next;
    fab.dataset.state = next;
    const who = auth && auth.currentUser ? `${auth.currentUser.email}\n` : '';
    statusEl.textContent = who + (detail || STATUS_TEXT[next]);
    signInBtn.style.display = uid ? 'none' : '';
    signOutBtn.style.display = uid ? '' : 'none';
}
function refreshStatus() {
    if (!uid) return setStatus('off');
    if (!navigator.onLine) return setStatus('offline');
    if (!connected) return setStatus('connecting');
    setStatus(Object.keys(readMeta().dirty).length ? 'syncing' : 'ok');
}
window.addEventListener('online', () => {
    refreshStatus();
    if (uid && !connected && auth.currentUser) connect(auth.currentUser); // 離線時開啟的：連上線後補做對齊
    else if (uid && connected && Object.keys(readMeta().dirty).length) flush(); // 離線時改的：連上線後補傳
});
window.addEventListener('offline', refreshStatus);

/* --- 本機有變動：記下來，稍後上傳 --- */
window.addEventListener('pomodoro:change', (e) => {
    const key = e.detail.key;
    if (applying || (!KV_NAME[key] && key !== K.logs)) return;
    markDirty(key);
    if (!uid) return; // 還沒登入：登入時再一起處理
    schedulePush();
});

function schedulePush() {
    clearTimeout(pushTimer);
    pushTimer = setTimeout(flush, 800);
    refreshStatus();
}

async function flush() {
    clearTimeout(pushTimer);
    if (!uid || !connected) return;
    const dirty = { ...readMeta().dirty };
    try {
        await Promise.all(Object.entries(dirty).map(([key, version]) => {
            if (key !== K.logs && !KV_NAME[key]) { clearDirty(key); return null; } // 舊版留下、已經不同步的項目
            return (key === K.logs ? pushLogs() : pushKv(key)).then(() => clearDirty(key, version));
        }));
        refreshStatus();
    } catch (err) {
        console.error('[sync] 上傳失敗', err);
        setStatus('error');
    }
}

async function pushKv(key) {
    const ref = fb.doc(db, 'users', uid, 'kv', KV_NAME[key]);
    let value = localStorage.getItem(key);

    // 有版本時間的資料（計時狀態）：雲端的比較新就不要蓋過去，改成採用雲端的
    const localRev = app.revOf(key, value);
    if (localRev !== null) {
        const snap = await fb.getDoc(ref);
        if (snap.exists() && app.revOf(key, snap.data().value) > localRev) {
            clearDirty(key);
            applyLocal(key, snap.data().value);
            return;
        }
    }

    // 任務庫與行程：上傳前先看雲端是不是被別台改過；改過就逐項合併，把合併結果同時寫回本機與雲端
    if (MERGEABLE.has(key) && value !== null) {
        const snap = await fb.getDoc(ref);
        const remote = snap.exists() ? snap.data().value : null;
        if (remote !== null && remote !== value && remote !== getBase(key)) {
            const merged = app.merge(key, getBase(key), value, remote);
            if (merged !== value) { applyLocal(key, merged); value = merged; }
        }
    }

    if (value === null) await fb.deleteDoc(ref);
    else await fb.setDoc(ref, { value, updatedAt: Date.now() });
    setBase(key, value);
}

// 記錄用差異上傳：本機有、雲端沒有的新增；雲端有、本機刪掉的刪除
async function pushLogs() {
    const local = app.loadLogs();
    const localIds = new Set(local.map(logId));
    const toAdd = local.filter(l => !knownRemoteLogs.has(logId(l)));
    const toDelete = [...knownRemoteLogs].filter(id => !localIds.has(id));
    const ops = [
        ...toAdd.map(l => batch => batch.set(fb.doc(db, 'users', uid, 'logs', logId(l)), { value: JSON.stringify(l) })),
        ...toDelete.map(id => batch => batch.delete(fb.doc(db, 'users', uid, 'logs', id)))
    ];
    for (let i = 0; i < ops.length; i += 400) { // Firestore 每批最多 500 筆
        const batch = fb.writeBatch(db);
        ops.slice(i, i + 400).forEach(op => op(batch));
        await batch.commit();
    }
    toAdd.forEach(l => knownRemoteLogs.add(logId(l)));
    toDelete.forEach(id => knownRemoteLogs.delete(id));
    rememberLogIds();
}

/* --- 雲端有變動：寫回本機並更新畫面 --- */
function applyLocal(key, value) {
    if (localStorage.getItem(key) === value) return;
    applying = true;
    try {
        if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value);
        app.applyRemote(key);
    } finally { applying = false; }
}

function onKvSnapshot(snap) {
    const dirty = readMeta().dirty;
    snap.docChanges().forEach(change => {
        const key = KV[change.doc.id];
        if (!key) return;
        const value = change.type === 'removed' ? null : change.doc.data().value;
        if (dirty[key]) {
            // 本機有還沒傳上去的修改：以本機為準。例外是有版本時間的資料，雲端比較新就採用雲端的
            const localRev = app.revOf(key, localStorage.getItem(key));
            if (localRev === null || value === null || app.revOf(key, value) <= localRev) return;
            clearDirty(key);
        }
        applyLocal(key, value);
        setBase(key, value); // 這份資料現在和雲端一致
    });
    refreshStatus();
}

// 把雲端某個範圍的記錄和本機對齊。
// remote：Map(文件名稱 → 內容)；since：這批資料涵蓋的起點（文件名稱開頭是開始時間，空字串代表全部）
function mergeRemoteLogs(remote, since) {
    const inRange = id => id >= since;
    let local = app.loadLogs();
    const localIds = new Set(local.map(logId));
    let changed = false;

    // 其他裝置新增的記錄（已知但本機沒有的，是這台裝置自己刪的，不要加回來）
    remote.forEach((value, id) => {
        if (localIds.has(id) || knownRemoteLogs.has(id)) return;
        try { local.push(JSON.parse(value)); changed = true; } catch (err) {}
    });
    // 其他裝置刪掉的記錄（以前在雲端、現在這個範圍內不見了）
    const removed = new Set([...knownRemoteLogs].filter(id => inRange(id) && !remote.has(id)));
    if (removed.size) { local = local.filter(l => !removed.has(logId(l))); changed = true; }

    // 範圍外的沿用原本所知，範圍內的以這次看到的為準
    knownRemoteLogs = new Set([...[...knownRemoteLogs].filter(id => !inRange(id)), ...remote.keys()]);
    rememberLogIds();
    if (changed) {
        applying = true;
        try { app.saveLogs(local); app.applyRemote(K.logs); } finally { applying = false; }
    }

    // 本機和雲端不一致（本機有新的，或本機已刪除／過期），排程上傳
    const now = app.loadLogs();
    const nowIds = new Set(now.map(logId));
    if (now.some(l => !knownRemoteLogs.has(logId(l))) || [...knownRemoteLogs].some(id => !nowIds.has(id))) {
        markDirty(K.logs);
        schedulePush();
    }
}

const logDocsToMap = snap => new Map(snap.docs.map(d => [d.id, d.data().value]));

// 完整核對全部記錄（讀取量大，只偶爾做）
async function fullLogSync() {
    const snap = await fb.getDocs(fb.collection(db, 'users', uid, 'logs'));
    mergeRemoteLogs(logDocsToMap(snap), '');
    const meta = readMeta(); meta.lastFull = Date.now(); writeMeta(meta);
}

/* --- 登入後第一次對齊 --- */
function localHasData() {
    const sched = JSON.parse(localStorage.getItem(K.schedule) || '[]');
    return localStorage.getItem(K.categories) !== null || sched.length > 0;
}

async function onSignedIn(user) {
    uid = user.uid;
    setStatus('connecting');
    const meta = readMeta();
    const sameAccount = meta.uid === uid;
    knownRemoteLogs = new Set(sameAccount ? meta.logIds : []);
    if (!sameAccount) { const m0 = readMeta(); m0.base = {}; writeMeta(m0); } // 換了帳號，之前記的 base 不能用

    const snap = await fb.getDocs(fb.collection(db, 'users', uid, 'kv'));
    const cloud = {};
    snap.forEach(d => { cloud[d.id] = d.data().value; });
    const cloudHasData = Object.keys(cloud).length > 0;

    let useCloud = cloudHasData;
    if (cloudHasData && !sameAccount && localHasData()) {
        useCloud = confirm(
            '雲端已經有資料。\n\n' +
            '按「確定」：改用雲端的任務庫、行程與設定（這台裝置的會被取代）\n' +
            '按「取消」：用這台裝置的資料覆蓋雲端\n\n' +
            '時間記錄兩邊都會保留並合併。');
    }

    const dirtyKeys = Object.keys(meta.dirty).filter(k => KV_NAME[k]);
    if (useCloud) {
        // 同一個帳號且離線時改過的項目，以本機為準
        Object.entries(KV).forEach(([name, key]) => {
            if (sameAccount && dirtyKeys.includes(key)) return; // 上傳時會和雲端合併（見 pushKv）
            if (name in cloud) { applyLocal(key, cloud[name]); setBase(key, cloud[name]); }
        });
    } else {
        app.ensureSaved();
        Object.entries(KV).forEach(([name, key]) => {
            if (localStorage.getItem(key) !== null) markDirty(key);
            // 使用者選了用這台的資料覆蓋雲端：把雲端現況當成 base，上傳時就不會再合併回來
            if (name in cloud) setBase(key, cloud[name]);
        });
    }

    const m = readMeta(); m.uid = uid; writeMeta(m);

    if (!sameAccount || !meta.lastFull || Date.now() - meta.lastFull > FULL_SYNC_DAYS * DAY_MS) await fullLogSync();

    const since = String(Date.now() - LOG_WINDOW_DAYS * DAY_MS);
    const recentLogs = fb.query(fb.collection(db, 'users', uid, 'logs'), fb.where(fb.documentId(), '>=', since));
    const onError = err => { console.error('[sync]', err); setStatus('error'); };
    unsubscribers = [
        fb.onSnapshot(fb.collection(db, 'users', uid, 'kv'), onKvSnapshot, onError),
        fb.onSnapshot(recentLogs, snap => mergeRemoteLogs(logDocsToMap(snap), since), onError)
    ];
    connected = true;
    await flush();
}

function disconnect() {
    clearTimeout(retryTimer);
    unsubscribers.forEach(u => u());
    unsubscribers = [];
    connected = false;
}

// 登入後的對齊；失敗（多半是離線）就稍後再試，網頁照常可用
async function connect(user) {
    disconnect();
    const known = readMeta().uid === user.uid; // 這台裝置以前確認過這個帳號有權限
    if (!known) lock('確認帳號中…', false);
    try {
        await onSignedIn(user); // 第一步就會讀雲端資料，規則不允許的帳號會在這裡被拒絕
        unlock();
    } catch (err) {
        console.error('[sync]', err);
        disconnect();
        if (err && err.code === 'permission-denied') {
            // 這個帳號不在 Firestore 規則允許的範圍內
            const m = readMeta(); if (m.uid === user.uid) { m.uid = null; writeMeta(m); }
            gateNotice = `${user.email || '這個帳號'} 沒有使用權限。\n請改用有權限的 Google 帳號登入。`;
            fb.signOut(auth).catch(() => {});
            return;
        }
        setStatus(navigator.onLine ? 'error' : 'offline');
        if (!known) lock('無法確認這個帳號的使用權限，請確認網路連線，稍後會自動重試。', false);
        retryTimer = setTimeout(() => { if (auth.currentUser) connect(auth.currentUser); }, 30000);
    }
}

function onSignedOut() {
    disconnect();
    uid = null;
    refreshStatus();
    lock(gateNotice || GATE_DEFAULT);
    gateNotice = '';
}

async function signIn() {
    if (IN_APP_BROWSER) {
        const msg = '這是 App 內建的瀏覽器，Google 不允許在這裡登入。\n請從右上角選單選「用瀏覽器開啟」（Chrome 或 Safari），再登入一次。';
        setStatus('off', msg); gateMsg.textContent = msg;
        return;
    }
    const provider = new fb.GoogleAuthProvider();
    try {
        await fb.signInWithPopup(auth, provider);
    } catch (err) {
        // 彈出視窗被擋時改用整頁跳轉登入
        if (err.code === 'auth/popup-blocked' || err.code === 'auth/operation-not-supported-in-this-environment') {
            await fb.signInWithRedirect(auth, provider);
        } else if (err.code !== 'auth/popup-closed-by-user' && err.code !== 'auth/cancelled-popup-request') {
            console.error('[sync] 登入失敗', err);
            const msg = `登入失敗：${err.code || err.message}`;
            setStatus('error', msg); gateMsg.textContent = msg;
        }
    }
}

// 登出：先把還沒上傳的修改送出去，再清掉這台裝置上的資料（偏好設定如深色模式會留著）
async function signOutAndClear() {
    if (!confirm('登出後會清除這台裝置上的資料。\n雲端的資料不受影響，再登入就會同步回來。\n\n確定登出？')) return;
    await flush();
    if (Object.keys(readMeta().dirty).length &&
        !confirm('有修改還沒上傳到雲端（可能是離線）。\n現在登出，這些修改會遺失。\n\n仍然要登出嗎？')) return;
    disconnect();
    clearDriveToken();
    try { await fb.signOut(auth); } catch (err) {}
    Object.keys(localStorage)
        .filter(k => k.startsWith('pomodoro_') && k !== 'pomodoro_prefs_v1')
        .forEach(k => localStorage.removeItem(k));
    location.reload();
}

// LINE、Facebook 等 App 內建的瀏覽器：Google 不允許在裡面登入
const IN_APP_BROWSER = /\bLine\/|FBAN|FBAV|FB_IAB|Instagram|MicroMessenger/i.test(navigator.userAgent);

/* --- 存到 Google 雲端硬碟 ---
 * 只要求 drive.file 權限：只能讀寫這個網站自己建立的檔案。
 * 授權（access token）由 Google 發給，約 1 小時過期；網頁沒辦法在背景自己續期，
 * 過期後要由使用者按按鈕（跳出 Google 視窗）重新取得。 */
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const DRIVE_TOKEN_KEY = 'pomodoro_drive_token';
const DRIVE_FILE_NAME = '蕃茄鐘記錄.md';
let driveToken = null; // { value, exp }

function currentDriveToken() {
    const valid = t => t && typeof t.value === 'string' && t.exp > Date.now() + 60000;
    if (valid(driveToken)) return driveToken.value;
    try { const t = JSON.parse(sessionStorage.getItem(DRIVE_TOKEN_KEY) || 'null'); if (valid(t)) { driveToken = t; return t.value; } } catch (err) {}
    return null;
}
function clearDriveToken() { driveToken = null; try { sessionStorage.removeItem(DRIVE_TOKEN_KEY); } catch (err) {} }

async function requestDriveToken() {
    const provider = new fb.GoogleAuthProvider();
    provider.addScope(DRIVE_SCOPE);
    if (auth.currentUser.email) provider.setCustomParameters({ login_hint: auth.currentUser.email });
    const result = await fb.reauthenticateWithPopup(auth.currentUser, provider);
    const cred = fb.GoogleAuthProvider.credentialFromResult(result);
    if (!cred || !cred.accessToken) throw new Error('no-token');
    driveToken = { value: cred.accessToken, exp: Date.now() + 55 * 60000 };
    try { sessionStorage.setItem(DRIVE_TOKEN_KEY, JSON.stringify(driveToken)); } catch (err) {}
    return driveToken.value;
}

async function driveError(res) {
    let message = '';
    try { message = (await res.json()).error.message || ''; } catch (err) {}
    if (res.status === 401) { clearDriveToken(); return { ok: false, reason: 'need-auth' }; }
    if (res.status === 403 && /has not been used|is disabled|accessNotConfigured/i.test(message)) return { ok: false, reason: 'api-disabled' };
    if (res.status === 403 && /insufficient|scope/i.test(message)) { clearDriveToken(); return { ok: false, reason: 'no-scope' }; }
    return { ok: false, reason: 'error', detail: `${res.status} ${message}`.trim() };
}

// interactive = true：可以跳出 Google 的授權視窗（只能在使用者按按鈕時用）
async function driveSave(interactive) {
    if (!uid || !auth.currentUser) return { ok: false, reason: 'signed-out' };
    let token = currentDriveToken();
    if (!token) {
        if (!interactive) return { ok: false, reason: 'need-auth' };
        try { token = await requestDriveToken(); }
        catch (err) {
            const code = (err && err.code) || '';
            if (code === 'auth/popup-blocked') return { ok: false, reason: 'popup' };
            if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') return { ok: false, reason: 'cancelled' };
            if (code === 'auth/user-mismatch') return { ok: false, reason: 'mismatch' };
            return { ok: false, reason: 'error', detail: code || String((err && err.message) || err) };
        }
    }
    const text = app.buildDriveText();
    const authHeader = { Authorization: `Bearer ${token}` };
    let id = app.getDriveFileId();

    if (id) { // 已經有檔案：整份覆蓋
        const res = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(id)}?uploadType=media`, {
            method: 'PATCH', headers: { ...authHeader, 'Content-Type': 'text/markdown; charset=UTF-8' }, body: text
        });
        if (res.ok) return { ok: true, id };
        if (res.status !== 404) return driveError(res);
        id = null; // 檔案被刪掉了，重新建立
    }
    const boundary = `pomodoro-${Date.now()}`;
    const body = [
        `--${boundary}`, 'Content-Type: application/json; charset=UTF-8', '',
        JSON.stringify({ name: DRIVE_FILE_NAME, mimeType: 'text/markdown' }),
        `--${boundary}`, 'Content-Type: text/markdown; charset=UTF-8', '', text,
        `--${boundary}--`
    ].join('\r\n');
    const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
        method: 'POST', headers: { ...authHeader, 'Content-Type': `multipart/related; boundary=${boundary}` }, body
    });
    if (!res.ok) return driveError(res);
    id = (await res.json()).id;
    app.setDriveFileId(id);
    return { ok: true, id };
}

/* --- 給 script.js 用 --- */
window.pomodoroSync = {
    isSignedIn: () => !!uid,
    flush,
    driveSave,
    // 重置全部時一併清空雲端
    async resetCloud() {
        if (!uid) return;
        const [kv, logs] = await Promise.all([
            fb.getDocs(fb.collection(db, 'users', uid, 'kv')),
            fb.getDocs(fb.collection(db, 'users', uid, 'logs'))
        ]);
        const refs = [...kv.docs, ...logs.docs].map(d => d.ref);
        for (let i = 0; i < refs.length; i += 400) {
            const batch = fb.writeBatch(db);
            refs.slice(i, i + 400).forEach(r => batch.delete(r));
            await batch.commit();
        }
        knownRemoteLogs = new Set();
        const meta = readMeta(); meta.dirty = {}; meta.logIds = []; meta.base = {}; writeMeta(meta);
    }
};

/* --- 啟動 --- */
async function start() {
    if (!firebaseConfig) { unlock(); return; } // 還沒設定 Firebase：沒有同步，也沒有登入門檻
    fab.style.display = '';
    setStatus('connecting', '載入同步功能中…');
    try {
        const base = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}`;
        const [appMod, authMod, fsMod] = await Promise.all([
            import(`${base}/firebase-app.js`),
            import(`${base}/firebase-auth.js`),
            import(`${base}/firebase-firestore.js`)
        ]);
        fb = { ...authMod, ...fsMod };
        const fbApp = appMod.initializeApp(firebaseConfig);
        auth = authMod.getAuth(fbApp);
        db = fsMod.getFirestore(fbApp);
    } catch (err) {
        console.error('[sync] 無法載入 Firebase', err);
        setStatus('error', '無法載入同步功能（可能是離線），網頁仍可照常使用。');
        // 這台裝置沒登入過就進不來；登入過的照常離線使用
        if (!readMeta().uid) lock('需要網路連線才能登入。\n請連上網路後重新整理。', false);
        return;
    }

    signInBtn.onclick = signIn;
    gateBtn.onclick = signIn;
    signOutBtn.onclick = signOutAndClear;

    fb.getRedirectResult(auth).catch(err => console.error('[sync] 登入失敗', err));
    fb.onAuthStateChanged(auth, user => {
        if (user) connect(user);
        else onSignedOut();
    });
}

start();
