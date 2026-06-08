/*
 * Auto Retry (Lumiverse Spindle frontend extension)
 * Re-fires failed, empty, stalled, or cut-off generations.
 * Lumiverse runs the LLM call server-side, so there is no browser fetch to
 * patch. This listens to generation lifecycle events and re-triggers the
 * chat's regenerate control when a generation fails, stalls, or returns empty.
 *
 * Settings can be edited live from the UI: open the chat input "Extras" popover
 * and pick "Auto Retry settings". Changes are saved to localStorage and applied
 * to the next generation, so you never have to touch the GitHub files.
 */
const STORE_KEY = 'lv-auto-retry:settings:v1';
// ---- defaults (the UI overrides these; editing here changes the fallback) ----
const CONFIG = {
    enabled: true,
    // retry budget
    maxRetries: 4,
    retryDelayMs: 1200, // first retry fires a touch sooner; backoff still climbs
    backoffFactor: 2,
    maxDelayMs: 30000,
    jitter: true,
    // rate limiting (HTTP 429 / overloaded)
    rateLimitDelayMs: 8000,
    // watchdogs
    stuckTimeoutMs: 60000, // started but never produced a token or an end. 0 disables.
    idleTimeoutMs: 20000, // tokens were flowing then stopped this long (mid-stream cutoff). 0 disables.
    // what counts as needing a retry
    retryOnError: true,
    retryOnEmpty: true, // also catches a generation cut off mid-reasoning (reasoning seen, content empty)
    retryOnTruncated: true, // final content present but cut off mid-sentence (structural heuristic, see looksTruncated)
    retryOnNoPunct: false, // extra: also treat "ends with no punctuation" as truncated. Noisy in RP, off by default.
    retryOnShort: false, // off by default. Caused endless regen in the original.
    minChars: 24,
    // host controls (the only DOM-dependent part). Use the Test buttons in settings.
    regenerateSelector: '[data-action="regenerate"], [data-testid="regenerate"], ' +
        'button[aria-label*="regenerate" i], button[title*="regenerate" i]',
    swipeNextSelector: '[data-action="swipe-right"], button[aria-label*="next swipe" i], button[aria-label*="next" i]',
    stopSelector: '[class*="_sendBtnStop_"]',
    toast: true,
    log: true,
};
const SCHEMA = [
    { title: 'General', fields: [
            { key: 'enabled', label: 'Enable auto-retry', type: 'bool' },
        ] },
    { title: 'Retry budget', fields: [
            { key: 'maxRetries', label: 'Max retries per message', type: 'num', hint: 'Hard cap. Every retry path shares it.' },
            { key: 'retryDelayMs', label: 'Base delay (ms)', type: 'num' },
            { key: 'backoffFactor', label: 'Backoff factor', type: 'num', hint: 'Delay multiplies by this each attempt.' },
            { key: 'maxDelayMs', label: 'Max delay (ms)', type: 'num' },
            { key: 'rateLimitDelayMs', label: 'Rate-limit floor (ms)', type: 'num', hint: 'Minimum wait when the error looks like a 429.' },
        ] },
    { title: 'Watchdogs', fields: [
            { key: 'stuckTimeoutMs', label: 'No-start timeout (ms)', type: 'num', hint: 'Started but no token and no end. 0 disables.' },
            { key: 'idleTimeoutMs', label: 'Mid-stream idle timeout (ms)', type: 'num', hint: 'Tokens stopped flowing. 0 disables.' },
        ] },
    { title: 'What to retry', fields: [
            { key: 'retryOnError', label: 'Provider errors', type: 'bool' },
            { key: 'retryOnEmpty', label: 'Empty / cut off mid-reasoning', type: 'bool' },
            { key: 'retryOnTruncated', label: 'Cut-off final response', type: 'bool', hint: 'Detects a reply that ends mid-sentence (open quote, action, code fence, trailing comma).' },
            { key: 'retryOnNoPunct', label: 'Also: ends with no punctuation', type: 'bool', hint: 'Stricter. Can re-roll good replies that just end on a word.' },
            { key: 'retryOnShort', label: 'Short responses', type: 'bool' },
            { key: 'minChars', label: 'Short threshold (chars)', type: 'num' },
        ] },
    { title: 'Host controls', fields: [
            { key: 'regenerateSelector', label: 'Regenerate selector', type: 'text', selector: true },
            { key: 'swipeNextSelector', label: 'Swipe-next selector', type: 'text', selector: true },
            { key: 'stopSelector', label: 'Stop button selector', type: 'text', selector: true },
        ] },
    { title: 'Feedback', fields: [
            { key: 'toast', label: 'Show toasts', type: 'bool' },
            { key: 'log', label: 'Console logging', type: 'bool' },
        ] },
];
// Final content present but cut off mid-sentence. Lumiverse does not expose
// finish_reason on GENERATION_ENDED (confirmed against the Generation API), so
// this works off the only signal a frontend extension has: the shape of the
// text. Conservative on purpose to avoid re-rolling good roleplay replies.
function looksTruncated(text, retryOnNoPunct) {
    const t = String(text == null ? '' : text).replace(/\s+$/, '');
    if (!t)
        return false; // empty is handled by the empty branch
    if ((t.match(/```/g) || []).length % 2 === 1)
        return true; // open code fence
    if ((t.replace(/```/g, '').match(/`/g) || []).length % 2 === 1)
        return true; // open inline code
    if ((t.match(/\*/g) || []).length % 2 === 1)
        return true; // open emphasis / RP action
    if ((t.match(/"/g) || []).length % 2 === 1)
        return true; // open straight-quote dialogue
    if ((t.match(/\u201C/g) || []).length !== (t.match(/\u201D/g) || []).length)
        return true; // mismatched smart quotes
    if (/[,;]$/.test(t))
        return true; // cut mid-clause
    if (retryOnNoPunct && !/[.!?\u2026"'*)\]}\u201D~>\-\u2014:]$/.test(t))
        return true;
    return false;
}
export function setup(ctx, opts) {
    // cfg is mutable so the settings modal can change it live. Order: code
    // defaults, then GitHub opts, then whatever the user saved in the UI.
    const cfg = Object.assign({}, CONFIG, opts || {}, loadSaved());
    const log = (...a) => { if (cfg.log)
        console.log('[auto-retry]', ...a); };
    const disposers = [];
    function loadSaved() {
        try {
            if (typeof localStorage === 'undefined')
                return {};
            const raw = localStorage.getItem(STORE_KEY);
            if (!raw)
                return {};
            const parsed = JSON.parse(raw);
            const out = {};
            for (const g of SCHEMA)
                for (const f of g.fields) {
                    if (!(f.key in parsed))
                        continue;
                    out[f.key] = coerce(f.type, parsed[f.key], CONFIG[f.key]);
                }
            return out;
        }
        catch (_) {
            return {};
        }
    }
    function saveSaved() {
        try {
            if (typeof localStorage === 'undefined')
                return;
            const out = {};
            for (const g of SCHEMA)
                for (const f of g.fields)
                    out[f.key] = cfg[f.key];
            localStorage.setItem(STORE_KEY, JSON.stringify(out));
        }
        catch (_) { }
    }
    function coerce(type, val, fallback) {
        if (type === 'bool')
            return !!val;
        if (type === 'num') {
            const n = Number(val);
            return Number.isFinite(n) ? n : fallback;
        }
        return val == null ? fallback : String(val);
    }
    // ---- per-chat state ----
    const chats = new Map();
    const st = (chatId) => {
        let s = chats.get(chatId);
        if (!s) {
            s = {
                attempts: 0, pending: false, selfTriggered: false,
                genId: null, startTimer: null, idleTimer: null, timer: null,
                sawReasoning: false, sawContent: false, ignoreEndFor: null,
            };
            chats.set(chatId, s);
        }
        return s;
    };
    const clearTimers = (s) => {
        if (s.startTimer) {
            clearTimeout(s.startTimer);
            s.startTimer = null;
        }
        if (s.idleTimer) {
            clearTimeout(s.idleTimer);
            s.idleTimer = null;
        }
        if (s.timer) {
            clearTimeout(s.timer);
            s.timer = null;
        }
        s.pending = false;
    };
    const isRateLimit = (err) => !!err && /\b429\b|rate.?limit|too many requests|quota|overloaded/i.test(String(err));
    const computeDelay = (attempt, rateLimited) => {
        let d = cfg.retryDelayMs * Math.pow(cfg.backoffFactor, Math.max(0, attempt - 1));
        d = Math.min(d, cfg.maxDelayMs);
        if (rateLimited)
            d = Math.max(d, cfg.rateLimitDelayMs * attempt);
        if (cfg.jitter)
            d = Math.round(d * (0.85 + Math.random() * 0.3));
        return d;
    };
    const find = (selector) => {
        let el = null;
        try {
            el = ctx && ctx.dom && ctx.dom.query ? ctx.dom.query(selector) : null;
        }
        catch (_) { }
        if (!el && typeof document !== 'undefined') {
            try {
                el = document.querySelector(selector);
            }
            catch (_) { }
        }
        return el;
    };
    const fireRetry = () => {
        const btn = find(cfg.regenerateSelector) || find(cfg.swipeNextSelector);
        if (btn) {
            btn.click();
            return true;
        }
        log('no regenerate control found, set the regenerate selector in settings');
        toast('Auto-retry: regenerate button not found. Set the selector.');
        return false;
    };
    const stopGenerating = () => {
        const stop = find(cfg.stopSelector);
        if (stop) {
            stop.click();
            return true;
        }
        return false;
    };
    function scheduleRetry(chatId, reason, err) {
        const s = st(chatId);
        if (!cfg.enabled || s.pending)
            return;
        if (s.attempts >= cfg.maxRetries) {
            toast('Auto-retry: gave up after ' + cfg.maxRetries + ' attempts.');
            log('gave up', chatId, reason);
            s.attempts = 0;
            return;
        }
        s.attempts += 1;
        const rl = isRateLimit(err);
        const delay = computeDelay(s.attempts, rl);
        clearTimers(s);
        s.pending = true;
        log('retry ' + s.attempts + '/' + cfg.maxRetries + ' in ' + delay + 'ms (' + reason + (rl ? ', rate-limited' : '') + ')');
        toast('Auto-retry ' + s.attempts + '/' + cfg.maxRetries + ' (' + reason + ') in ' + (delay / 1000).toFixed(1) + 's');
        s.timer = setTimeout(() => {
            s.timer = null;
            s.pending = false;
            s.selfTriggered = true;
            if (!fireRetry()) {
                s.selfTriggered = false;
                s.attempts = 0;
            } // click failed, do not leave stale state
        }, delay);
    }
    // Stalled or stuck. Halt the dead generation (best effort) and retry.
    // Whatever terminal event the dead generation fires next is swallowed via
    // ignoreEndFor, and the retry is scheduled directly so it cannot be lost.
    function abortAndRetry(chatId, reason) {
        const s = st(chatId);
        clearTimers(s);
        s.ignoreEndFor = s.genId;
        stopGenerating();
        scheduleRetry(chatId, reason);
    }
    function onStart(p) {
        if (!p || !p.chatId)
            return;
        const s = st(p.chatId);
        if (!s.selfTriggered)
            s.attempts = 0; // fresh, user-initiated generation
        s.selfTriggered = false;
        s.genId = p.generationId;
        s.sawReasoning = false;
        s.sawContent = false;
        clearTimers(s);
        if (cfg.enabled && cfg.stuckTimeoutMs > 0) {
            s.startTimer = setTimeout(() => abortAndRetry(p.chatId, 'stuck'), cfg.stuckTimeoutMs);
        }
    }
    function onToken(p) {
        if (!p || !p.chatId)
            return;
        const s = st(p.chatId);
        if (p.type === 'reasoning')
            s.sawReasoning = true;
        else
            s.sawContent = true;
        // streaming is alive: drop the start watchdog, arm the idle watchdog
        if (s.startTimer) {
            clearTimeout(s.startTimer);
            s.startTimer = null;
        }
        if (cfg.enabled && cfg.idleTimeoutMs > 0) {
            if (s.idleTimer)
                clearTimeout(s.idleTimer);
            s.idleTimer = setTimeout(() => abortAndRetry(p.chatId, 'stalled'), cfg.idleTimeoutMs);
        }
    }
    function onEnd(p) {
        if (!p || !p.chatId)
            return;
        const s = st(p.chatId);
        if (s.ignoreEndFor && p.generationId === s.ignoreEndFor)
            return; // dead gen, retry already scheduled
        clearTimers(s);
        if (p.error) {
            if (cfg.retryOnError)
                scheduleRetry(p.chatId, 'error', p.error);
            return;
        }
        const content = String(p.content || '').trim();
        if (cfg.retryOnEmpty && content.length === 0) {
            scheduleRetry(p.chatId, (s.sawReasoning && !s.sawContent) ? 'cut off mid-reasoning' : 'empty');
            return;
        }
        if (cfg.retryOnTruncated && looksTruncated(content, cfg.retryOnNoPunct)) {
            scheduleRetry(p.chatId, 'cut off');
            return;
        }
        if (cfg.retryOnShort && content.length < cfg.minChars) {
            scheduleRetry(p.chatId, 'short');
            return;
        }
        s.attempts = 0; // clean success
    }
    function onStop(p) {
        if (!p || !p.chatId)
            return;
        const s = st(p.chatId);
        if (s.ignoreEndFor && p.generationId === s.ignoreEndFor)
            return; // our abort, retry already scheduled
        clearTimers(s);
        s.attempts = 0; // genuine user stop, do not fight them
    }
    function toast(msg) {
        if (!cfg.toast || typeof document === 'undefined')
            return;
        try {
            let t = document.getElementById('__lvRetryToast');
            if (!t) {
                t = document.createElement('div');
                t.id = '__lvRetryToast';
                t.style.cssText =
                    'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:2147483647;' +
                        'font:13px/1.4 var(--lumiverse-font-family,system-ui);padding:9px 14px;border-radius:10px;' +
                        'color:var(--lumiverse-text,#fff);background:var(--lumiverse-fill-strong,rgba(20,16,30,.96));' +
                        'border:1px solid var(--lumiverse-border,rgba(255,255,255,.18));' +
                        'box-shadow:0 8px 24px rgba(0,0,0,.45);pointer-events:none;transition:opacity .25s ease;' +
                        'opacity:0;max-width:80vw;text-align:center';
                (document.body || document.documentElement).appendChild(t);
            }
            t.textContent = msg;
            t.style.opacity = '1';
            clearTimeout(t.__h);
            t.__h = setTimeout(() => { t.style.opacity = '0'; }, 3200);
        }
        catch (_) { }
    }
    // ---- settings UI ----
    let modalHandle = null;
    function buildSettingsBody(root) {
        root.innerHTML = '';
        const panel = document.createElement('div');
        panel.style.cssText = 'display:flex;flex-direction:column;font:13px/1.45 var(--lumiverse-font-family,system-ui);color:var(--lumiverse-text,#eee)';
        // options live in their own scroll area so the footer never overlaps them
        const scroller = document.createElement('div');
        scroller.style.cssText = 'display:flex;flex-direction:column;gap:16px;overflow-y:auto;max-height:min(56vh,420px);padding-right:4px';
        for (const group of SCHEMA) {
            const sec = document.createElement('div');
            sec.style.cssText = 'display:flex;flex-direction:column;gap:8px';
            const h = document.createElement('div');
            h.textContent = group.title;
            h.style.cssText = 'font-size:11px;letter-spacing:.07em;text-transform:uppercase;color:var(--lumiverse-text-dim,#9a93a8)';
            sec.appendChild(h);
            for (const f of group.fields) {
                sec.appendChild(buildRow(f));
            }
            scroller.appendChild(sec);
        }
        panel.appendChild(scroller);
        // footer: a plain bar below the scroll area, set off by a single hairline rule
        const actions = document.createElement('div');
        actions.style.cssText = 'display:flex;align-items:center;gap:8px;flex:none;margin-top:14px;padding-top:14px;border-top:1px solid var(--lumiverse-border,rgba(255,255,255,.08))';
        const status = document.createElement('span');
        status.style.cssText = 'flex:1;font-size:12px;color:var(--lumiverse-text-dim,#9a93a8)';
        const reset = btn('Reset to defaults', false);
        reset.addEventListener('click', async () => {
            let ok = true;
            try {
                if (ctx?.ui?.showConfirm) {
                    const r = await ctx.ui.showConfirm({
                        title: 'Reset settings', message: 'Restore every Auto Retry setting to its default?',
                        variant: 'warning', confirmLabel: 'Reset',
                    });
                    ok = !!r?.confirmed;
                }
            }
            catch (_) { }
            if (!ok)
                return;
            for (const g of SCHEMA)
                for (const fl of g.fields)
                    cfg[fl.key] = CONFIG[fl.key];
            saveSaved();
            buildSettingsBody(root);
            log('settings reset to defaults');
        });
        const save = btn('Save', true);
        save.addEventListener('click', () => {
            saveSaved();
            status.textContent = 'Saved. Applies on the next generation.';
            log('settings saved', cfg);
            setTimeout(() => { status.textContent = ''; }, 2600);
        });
        actions.appendChild(status);
        actions.appendChild(reset);
        actions.appendChild(save);
        panel.appendChild(actions);
        root.appendChild(panel);
    }
    function buildRow(f) {
        // bool/num wrap in <label> so the whole row toggles or focuses its control.
        // text rows use <div> because they contain a Test button, which shouldn't sit inside a label.
        const row = document.createElement(f.type === 'text' ? 'div' : 'label');
        row.style.cssText = 'display:flex;flex-direction:column;gap:4px';
        const top = document.createElement('div');
        top.style.cssText = 'display:flex;align-items:center;gap:10px;justify-content:space-between';
        const name = document.createElement('span');
        name.textContent = f.label;
        top.appendChild(name);
        if (f.type === 'bool') {
            const input = document.createElement('input');
            input.type = 'checkbox';
            input.checked = !!cfg[f.key];
            input.style.cssText = 'width:16px;height:16px;accent-color:var(--lumiverse-primary,#7c5cff);cursor:pointer';
            input.addEventListener('change', () => { cfg[f.key] = input.checked; });
            top.appendChild(input);
            row.appendChild(top);
        }
        else if (f.type === 'num') {
            const input = document.createElement('input');
            input.type = 'number';
            input.value = String(cfg[f.key]);
            styleField(input);
            input.style.width = '120px';
            input.addEventListener('change', () => {
                const n = Number(input.value);
                cfg[f.key] = Number.isFinite(n) ? n : CONFIG[f.key];
                input.value = String(cfg[f.key]);
            });
            top.appendChild(input);
            row.appendChild(top);
        }
        else {
            row.appendChild(top);
            const input = document.createElement('input');
            input.type = 'text';
            input.value = String(cfg[f.key]);
            input.setAttribute('aria-label', f.label);
            styleField(input);
            input.addEventListener('change', () => { cfg[f.key] = input.value; });
            row.appendChild(input);
            if (f.selector) {
                const testRow = document.createElement('div');
                testRow.style.cssText = 'display:flex;align-items:center;gap:8px';
                const test = btn('Test', false);
                test.style.padding = '4px 10px';
                const res = document.createElement('span');
                res.style.cssText = 'font-size:12px;color:var(--lumiverse-text-dim,#9a93a8)';
                test.addEventListener('click', () => {
                    let match = false;
                    try {
                        match = !!document.querySelector(input.value);
                    }
                    catch (_) {
                        res.textContent = 'invalid selector';
                        res.style.color = 'var(--lumiverse-danger,#ff6b6b)';
                        return;
                    }
                    res.textContent = match ? 'match found' : 'no match on screen';
                    res.style.color = match ? 'var(--lumiverse-success,#46d39a)' : 'var(--lumiverse-text-dim,#9a93a8)';
                });
                testRow.appendChild(test);
                testRow.appendChild(res);
                row.appendChild(testRow);
            }
        }
        if (f.hint) {
            const hint = document.createElement('span');
            hint.textContent = f.hint;
            hint.style.cssText = 'font-size:11.5px;color:var(--lumiverse-text-dim,#9a93a8)';
            row.appendChild(hint);
        }
        return row;
    }
    function styleField(input) {
        input.style.cssText +=
            'padding:7px 9px;border-radius:var(--lumiverse-radius,8px);' +
                'border:1px solid var(--lumiverse-border,rgba(255,255,255,.16));' +
                'background:var(--lumiverse-fill-subtle,rgba(255,255,255,.05));' +
                'color:var(--lumiverse-text,#eee);font:13px var(--lumiverse-font-family,system-ui);outline:none;' +
                'transition:border-color .12s ease';
        input.addEventListener('focus', () => { input.style.borderColor = 'var(--lumiverse-primary,#7c5cff)'; });
        input.addEventListener('blur', () => { input.style.borderColor = 'var(--lumiverse-border,rgba(255,255,255,.16))'; });
    }
    function btn(label, primary) {
        const b = document.createElement('button');
        b.textContent = label;
        b.style.cssText =
            'padding:7px 14px;border-radius:var(--lumiverse-radius,8px);cursor:pointer;' +
                'font:13px var(--lumiverse-font-family,system-ui);transition:filter .12s ease;' +
                (primary
                    ? 'border:1px solid transparent;background:var(--lumiverse-primary,#7c5cff);color:var(--lumiverse-primary-contrast,#fff)'
                    : 'border:1px solid var(--lumiverse-border,rgba(255,255,255,.16));background:transparent;color:var(--lumiverse-text,#eee)');
        b.addEventListener('mouseenter', () => { b.style.filter = 'brightness(1.12)'; });
        b.addEventListener('mouseleave', () => { b.style.filter = 'none'; });
        return b;
    }
    function openSettings() {
        if (!ctx?.ui?.showModal) {
            log('host has no modal API; cannot open settings');
            return;
        }
        if (modalHandle) {
            try {
                modalHandle.dismiss();
            }
            catch (_) { }
            modalHandle = null;
        }
        const modal = ctx.ui.showModal({ title: 'Auto Retry settings', width: 460, maxHeight: 560 });
        modalHandle = modal;
        buildSettingsBody(modal.root);
        modal.onDismiss(() => { modalHandle = null; });
    }
    // entry point: a button in the chat input "Extras" popover
    try {
        if (ctx?.ui?.registerInputBarAction) {
            const action = ctx.ui.registerInputBarAction({
                id: 'auto-retry-settings',
                label: 'Auto Retry settings',
                iconSvg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7"/><polyline points="21 4 21 9 16 9"/></svg>',
            });
            disposers.push(action.onClick(() => openSettings()));
            disposers.push(() => { try {
                action.destroy();
            }
            catch (_) { } });
        }
        else {
            log('host has no input bar action API; open settings via ctx only');
        }
    }
    catch (e) {
        log('failed to register settings action', e);
    }
    const offs = [
        ctx.events.on('GENERATION_STARTED', onStart),
        ctx.events.on('STREAM_TOKEN_RECEIVED', onToken),
        ctx.events.on('GENERATION_ENDED', onEnd),
        ctx.events.on('GENERATION_STOPPED', onStop),
    ];
    log('ready', cfg);
    return () => {
        offs.forEach((o) => { try {
            o && o();
        }
        catch (_) { } });
        disposers.forEach((d) => { try {
            d && d();
        }
        catch (_) { } });
        if (modalHandle) {
            try {
                modalHandle.dismiss();
            }
            catch (_) { }
            modalHandle = null;
        }
        chats.forEach(clearTimers);
        chats.clear();
        try {
            if (typeof document !== 'undefined' && document.getElementById) {
                const t = document.getElementById('__lvRetryToast');
                if (t) {
                    clearTimeout(t.__h);
                    if (t.remove)
                        t.remove();
                }
            }
        }
        catch (_) { }
    };
}
