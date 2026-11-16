/* --- 雲端同步（Firebase：Google 登入 + Firestore） ---
 * 資料仍以 localStorage 為主，這裡只負責和雲端互相同步：
 *   users/{uid}/kv/{名稱}   任務庫、行程、時長設定、計時狀態，各一份（以最後寫入為準；計時狀態另外比版本時間）
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
    const value = localStorage.getItem(key);
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
    if (value === null) await fb.deleteDoc(ref);
    else await fb.setDoc(ref, { value, updatedAt: Date.now() });
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
            if (sameAccount && dirtyKeys.includes(key)) return;
            if (name in cloud) applyLocal(key, cloud[name]);
        });
    } else {
        app.ensureSaved();
        Object.values(KV).forEach(key => { if (localStorage.getItem(key) !== null) markDirty(key); });
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
    try {
        await onSignedIn(user);
    } catch (err) {
        console.error('[sync]', err);
        disconnect();
        setStatus(navigator.onLine ? 'error' : 'offline');
        retryTimer = setTimeout(() => { if (auth.currentUser) connect(auth.currentUser); }, 30000);
    }
}

function onSignedOut() {
    disconnect();
    uid = null;
    refreshStatus();
}

// LINE、Facebook 等 App 內建的瀏覽器：Google 不允許在裡面登入
const IN_APP_BROWSER = /\bLine\/|FBAN|FBAV|FB_IAB|Instagram|MicroMessenger/i.test(navigator.userAgent);

/* --- 給 script.js 用 --- */
window.pomodoroSync = {
    isSignedIn: () => !!uid,
    flush,
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
        const meta = readMeta(); meta.dirty = {}; meta.logIds = []; writeMeta(meta);
    }
};

/* --- 啟動 --- */
async function start() {
    if (!firebaseConfig) return; // 還沒設定 Firebase：不顯示同步功能
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
        return;
    }

    signInBtn.onclick = async () => {
        if (IN_APP_BROWSER) {
            setStatus('off', '這是 App 內建的瀏覽器，Google 不允許在這裡登入。\n請從右上角選單選「用瀏覽器開啟」（Chrome 或 Safari），再登入一次。');
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
                setStatus('error', `登入失敗：${err.code || err.message}`);
            }
        }
    };
    signOutBtn.onclick = () => {
        if (confirm('登出後這台裝置會停止同步（本機資料會保留）。確定登出？')) fb.signOut(auth);
    };

    fb.getRedirectResult(auth).catch(err => console.error('[sync] 登入失敗', err));
    fb.onAuthStateChanged(auth, user => {
        if (user) connect(user);
        else onSignedOut();
    });
}

start();
