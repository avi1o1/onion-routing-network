// Page logic of the Pages site: same sidebar and tabs as the Streamlit dashboard,
// with the network simulated by sim.js and the player shared through scene.js + player.js.

// ---------- Small helpers ----------
const $ = id => document.getElementById(id);
const MAX_EASY_STEPS = 30;      // above this many log events a run gets hard to follow
let run = null;                 // result of the last Run
let player = null;              // the mounted player

function esc(text) {
    // Escape text before putting it in HTML
    return String(text).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function table(rows, columns) {
    // Helper function: list of objects -> table that looks like st.dataframe. columns = [[key, header, kind]]
    let html = '<div class="tablewrap"><table class="df"><tr>';
    for (const col of columns) {
        html += "<th>" + esc(col[1]) + "</th>";
    }
    html += "</tr>";
    for (const row of rows) {
        html += "<tr>";
        for (const col of columns) {
            let value = row[col[0]];
            let cls = col[2] || "";
            if (value === true) {
                value = "☑";
            } else if (value === false) {
                value = "☐";
            } else if (value === null || value === undefined) {
                value = "";
            }
            if (typeof row[col[0]] === "number") {
                cls += " num";
            }
            html += '<td class="' + cls + '">' + esc(value) + "</td>";
        }
        html += "</tr>";
    }
    return html + "</table></div>";
}

function mean(values) {
    let sum = 0;
    for (const v of values) {
        sum += v;
    }
    return values.length ? sum / values.length : 0;
}

function std(values) {
    // Sample standard deviation, same as pandas' default
    if (values.length < 2) {
        return 0;
    }
    const m = mean(values);
    let sum = 0;
    for (const v of values) {
        sum += (v - m) * (v - m);
    }
    return Math.sqrt(sum / (values.length - 1));
}

// ---------- Sidebar widgets ----------
function buildSlider(box) {
    // A slider with its value floating above the thumb, like st.slider
    const id = box.dataset.id;
    box.innerHTML = '<span class="lbl">' + esc(box.dataset.label) + '</span><div class="track"><span class="val" id="' + id + 'Val"></span>' +
                    '<input type="range" id="' + id + '" min="' + box.dataset.min + '" max="' + box.dataset.max + '" step="' + (box.dataset.step || 1) +
                    '" value="' + box.dataset.value + '"></div>';
    const input = $(id);
    const show = () => {
        const p = (input.value - input.min) / (input.max - input.min);
        $(id + "Val").textContent = input.value;
        $(id + "Val").style.left = "calc(" + (p * 100) + "% + " + ((0.5 - p) * 14) + "px)";
    };
    input.addEventListener("input", () => { show(); syncSidebar(); });
    show();
}

function fillSelect(select, values, defaultIndex) {
    // Helper function: refill a select, keeping the current choice if it still exists
    const keep = select.value;
    select.innerHTML = values.map(v => "<option>" + v + "</option>").join("");
    if (values.map(String).includes(keep)) {
        select.value = keep;
    } else {
        select.selectedIndex = defaultIndex;
    }
}

function syncSidebar() {
    // Choices that depend on other knobs, and the pool warning
    const reqs = +$("reqs").value;
    const hops = +$("hops").value;
    const killAt = [];
    for (let i = 0; i < reqs; i++) {
        killAt.push(i);
    }
    const killHop = [];
    for (let i = 1; i <= hops; i++) {
        killHop.push(i);
    }
    fillSelect($("killAt"), killAt, Math.min(1, reqs - 1));
    fillSelect($("killHop"), killHop, Math.min(1, hops - 1));
    $("poolWarn").hidden = !($("killOn").checked && +$("pool").value < hops + 1);
}

function readConfig() {
    return {
        hops: +$("hops").value,
        relays: +$("pool").value,
        delayMs: +$("delay").value,
        lossPct: +$("loss").value,
        requests: +$("reqs").value,
        timeoutMs: +$("timeout").value,
        killAt: $("killOn").checked ? +$("killAt").value : null,
        killHop: +$("killHop").value - 1,
        retry: document.querySelector("input[name=policy]:checked").value === "retry",
        heartbeat: $("heartbeat").checked,
    };
}

// ---------- Charts (drawn to look like the matplotlib ones) ----------
function niceStep(max) {
    // Helper function: a round tick spacing giving about 5 ticks
    const raw = max / 5;
    const power = Math.pow(10, Math.floor(Math.log10(raw)));
    for (const m of [1, 2, 5, 10]) {
        if (raw <= m * power) {
            return m * power;
        }
    }
    return 10 * power;
}

function axes(w, h, pad, yMax, xLabel, yLabel) {
    // Left and bottom spines, y ticks and axis labels
    const step = niceStep(yMax);
    let svg = "";
    for (let v = 0; v <= yMax + 1e-9; v += step) {
        const y = h - pad.b - (v / yMax) * (h - pad.b - pad.t);
        svg += '<line x1="' + (pad.l - 4) + '" y1="' + y + '" x2="' + pad.l + '" y2="' + y + '" stroke="#31333f"/>';
        svg += '<text x="' + (pad.l - 7) + '" y="' + (y + 4) + '" text-anchor="end">' + Math.round(v * 10) / 10 + "</text>";
    }
    svg += '<line x1="' + pad.l + '" y1="' + pad.t + '" x2="' + pad.l + '" y2="' + (h - pad.b) + '" stroke="#31333f"/>';
    svg += '<line x1="' + pad.l + '" y1="' + (h - pad.b) + '" x2="' + (w - pad.r) + '" y2="' + (h - pad.b) + '" stroke="#31333f"/>';
    svg += '<text x="' + ((pad.l + w - pad.r) / 2) + '" y="' + (h - 6) + '" text-anchor="middle">' + xLabel + "</text>";
    svg += '<text transform="translate(16 ' + ((pad.t + h - pad.b) / 2) + ') rotate(-90)" text-anchor="middle">' + yLabel + "</text>";
    return svg;
}

function barChart(results) {
    // Latency of every request: green ok, orange recovered, red failed
    const w = 760, h = 300, pad = { l: 62, r: 16, t: 14, b: 46 };
    const yMax = Math.max(...results.map(r => r.latencyMs), 1) * 1.05;
    const slot = (w - pad.l - pad.r) / results.length;
    let svg = '<svg class="chart" viewBox="0 0 ' + w + " " + h + '">' + axes(w, h, pad, yMax, "Request #", "Latency (ms)");
    for (let i = 0; i < results.length; i++) {
        const r = results[i];
        let color = "var(--green)";
        if (!r.ok) {
            color = "var(--red)";
        } else if (r.attempts > 1) {
            color = "var(--orange)";
        }
        const barH = (r.latencyMs / yMax) * (h - pad.b - pad.t);
        const x = pad.l + i * slot + slot * 0.1;
        svg += '<rect x="' + x + '" y="' + (h - pad.b - barH) + '" width="' + slot * 0.8 + '" height="' + barH + '" fill="' + color + '"/>';
        svg += '<text x="' + (x + slot * 0.4) + '" y="' + (h - pad.b + 16) + '" text-anchor="middle">' + r.index + "</text>";
    }
    return svg + "</svg>";
}

function latencyChart(rows) {
    // Mean latency with error bars and circuit build time, 1 to 5 hops
    const w = 700, h = 350, pad = { l: 62, r: 16, t: 14, b: 46 };
    let yMax = 1;
    for (const r of rows) {
        yMax = Math.max(yMax, r.latencyMs + r.spread, r.buildMs);
    }
    yMax *= 1.08;
    const px = hops => pad.l + 30 + ((hops - 1) / 4) * (w - pad.l - pad.r - 60);
    const py = v => h - pad.b - (v / yMax) * (h - pad.b - pad.t);
    let svg = '<svg class="chart" viewBox="0 0 ' + w + " " + h + '">' + axes(w, h, pad, yMax, "Number of hops", "ms");
    let latPts = "";
    let buildPts = "";
    for (const r of rows) {
        svg += '<text x="' + px(r.hops) + '" y="' + (h - pad.b + 16) + '" text-anchor="middle">' + r.hops + "</text>";
        svg += '<line x1="' + px(r.hops) + '" y1="' + py(r.latencyMs - r.spread) + '" x2="' + px(r.hops) + '" y2="' + py(r.latencyMs + r.spread) + '" stroke="var(--blue)"/>';
        for (const v of [r.latencyMs - r.spread, r.latencyMs + r.spread]) {
            svg += '<line x1="' + (px(r.hops) - 4) + '" y1="' + py(v) + '" x2="' + (px(r.hops) + 4) + '" y2="' + py(v) + '" stroke="var(--blue)"/>';
        }
        latPts += px(r.hops) + "," + py(r.latencyMs) + " ";
        buildPts += px(r.hops) + "," + py(r.buildMs) + " ";
    }
    svg += '<polyline points="' + latPts + '" fill="none" stroke="var(--blue)" stroke-width="1.6"/>';
    svg += '<polyline points="' + buildPts + '" fill="none" stroke="var(--red)" stroke-width="1.6"/>';
    for (const r of rows) {
        svg += '<circle cx="' + px(r.hops) + '" cy="' + py(r.latencyMs) + '" r="4" fill="var(--blue)"/>';
        svg += '<rect x="' + (px(r.hops) - 4) + '" y="' + (py(r.buildMs) - 4) + '" width="8" height="8" fill="var(--red)"/>';
    }
    // Legend
    svg += '<rect x="' + (pad.l + 12) + '" y="' + (pad.t + 6) + '" width="170" height="48" fill="#fff" stroke="#ddd" rx="3"/>';
    svg += '<line x1="' + (pad.l + 22) + '" y1="' + (pad.t + 22) + '" x2="' + (pad.l + 46) + '" y2="' + (pad.t + 22) + '" stroke="var(--blue)" stroke-width="1.6"/><circle cx="' + (pad.l + 34) + '" cy="' + (pad.t + 22) + '" r="4" fill="var(--blue)"/>';
    svg += '<text x="' + (pad.l + 54) + '" y="' + (pad.t + 26) + '">request latency</text>';
    svg += '<line x1="' + (pad.l + 22) + '" y1="' + (pad.t + 42) + '" x2="' + (pad.l + 46) + '" y2="' + (pad.t + 42) + '" stroke="var(--red)" stroke-width="1.6"/><rect x="' + (pad.l + 30) + '" y="' + (pad.t + 38) + '" width="8" height="8" fill="var(--red)"/>';
    svg += '<text x="' + (pad.l + 54) + '" y="' + (pad.t + 46) + '">circuit build time</text>';
    return svg + "</svg>";
}

// ---------- Tabs ----------
function renderLayers() {
    const events = run.events;
    const wrapIndex = events.findIndex(e => e.kind === "wrap" && e.cmd === "REQUEST");
    if (wrapIndex < 0) {
        $("layersOut").innerHTML = '<div class="alert warning">No request was sent.</div>';
        return;
    }
    const layerRows = events[wrapIndex].layers.map(l => ({ hop: l.hop, size: l.size, prefix: l.prefix }));
    const peelRows = [];
    for (let i = wrapIndex + 1; i < events.length && events[i].who !== "client"; i++) {
        const e = events[i];
        if (e.kind === "peel") {
            peelRows.push({ relay: e.who, received: e.inPrefix, after: e.outPrefix, sizeIn: e.inSize, sizeOut: e.outSize });
        }
        if (e.kind === "exit") {
            peelRows.push({ relay: e.who + " (exit)", received: "", after: "plaintext: " + e.payload, sizeIn: null, sizeOut: null });
        }
    }
    $("layersOut").innerHTML =
        "<h3>1. Client wraps the request (innermost layer first)</h3>" +
        table(layerRows, [["hop", "layer for"], ["size", "ciphertext size (bytes)"], ["prefix", "first bytes", "mono"]]) +
        "<h3>2. Each relay peels one layer</h3>" +
        table(peelRows, [["relay", "relay"], ["received", "received", "mono"], ["after", "after peeling", "mono"], ["sizeIn", "size in"], ["sizeOut", "size out"]]) +
        '<p class="stcaption">The \'after peeling\' bytes of one hop are the \'received\' bytes of the next hop: that is the onion shrinking layer by layer.</p>';
}

function renderFailures() {
    const results = run.results;
    const detail = results.map(r => ({ request: r.index, ok: r.ok, latency: Math.round(r.latencyMs), attempts: r.attempts, rebuilt: r.rebuilt, error: r.error }));
    const slim = Scene.slimEvents(run.events);
    const interesting = ["killed", "request_failed", "rebuild_start", "dead_found", "build_failed", "heartbeat_failed", "circuit_ready", "giving_up", "drop"];
    const timeline = [];
    for (let i = 0; i < slim.length; i++) {
        if (interesting.includes(slim[i].kind)) {
            timeline.push({ t: Math.round(slim[i].t), who: Scene.whoLabel(slim[i].who), what: Scene.describe(slim, i) });
        }
    }
    $("failOut").innerHTML = barChart(results) +
        table(detail, [["request", "request"], ["ok", "ok"], ["latency", "latency (ms)"], ["attempts", "attempts"], ["rebuilt", "circuit rebuilt"], ["error", "error"]]) +
        "<h3>Failure timeline</h3>" + table(timeline, [["t", "t (ms)"], ["who", "who"], ["what", "what"]]);
}

function renderSaw() {
    const full = run.events.find(e => e.who === "client" && e.kind === "hop_added" && e.path.length === run.config.hops);
    if (!full) {
        $("sawOut").innerHTML = '<div class="alert warning">No complete circuit was built.</div>';
        return;
    }
    const rows = Sim.whatEachHopSaw(run.events, full.path, full.clientAddr);
    let claims = "";
    for (const c of Sim.checkClaims(rows)) {
        claims += '<div class="alert ' + (c[1] ? "success" : "error") + '">' + esc(c[0]) + "</div>";
    }
    $("sawOut").innerHTML =
        "<p>Circuit: client -> " + esc(full.path.join(" -> ")) + " -> destination</p>" +
        table(rows, [["relay", "relay"], ["position", "position"], ["knowsClient", "knows client address"], ["knowsNextHop", "knows next hop"],
                     ["knowsDestination", "knows destination"], ["seesPlaintext", "sees plaintext"]]) +
        "<h3>Anonymity claims checked against the logs</h3>" + claims +
        '<p class="stcaption">Try 1 hop: the single relay sees everything, so claim 1 breaks. Still true for any length: if the entry and exit are both malicious ' +
        "they can match traffic by timing, the exit sees the plaintext request (no end-to-end TLS here), and a compromised directory could hand out only its own relays.</p>";
}

function renderStepCount() {
    // Telling the user how long the story is
    const n = run.events.length;
    if (n > MAX_EASY_STEPS) {
        $("stepCount").innerHTML = '<div class="alert warning">This run has ' + n + " steps. Lower the hops or requests to keep it easy to follow.</div>";
    } else {
        $("stepCount").innerHTML = '<p class="caption">This run has ' + n + " steps.</p>";
    }
}

// ---------- Events ----------
async function runClicked() {
    $("run").disabled = true;
    run = await Sim.runExperiment(readConfig());
    if (player !== null) {
        player.destroy();
    }
    player = mountPlayer($("player"), Scene.buildPlayerData(run.events, run.relayNames, run.config.hops));
    window.player = player;
    renderStepCount();
    renderLayers();
    renderFailures();
    renderSaw();
    $("run").disabled = false;
}

async function sweepClicked() {
    $("sweep").disabled = true;
    $("sweep").textContent = "Running...";
    const config = Object.assign({}, readConfig(), { requests: 8, heartbeat: false });
    const raw = await Sim.sweepHops(config, [1, 2, 3, 4, 5], 2);
    const rows = [];
    for (const hops of [1, 2, 3, 4, 5]) {
        const mine = raw.filter(r => r.hops === hops);
        const lat = mine.map(r => r.latencyMs);
        rows.push({ hops: hops, latencyMs: mean(lat), spread: std(lat), buildMs: mean(mine.map(r => r.buildMs)) });
    }
    const shown = rows.map(r => ({ hops: r.hops, latencyMs: Math.round(r.latencyMs * 10) / 10, spread: Math.round(r.spread * 10) / 10, buildMs: Math.round(r.buildMs * 10) / 10 }));
    $("sweepOut").innerHTML = latencyChart(rows) +
        table(shown, [["hops", "hops"], ["latencyMs", "latencyMs"], ["spread", "spread"], ["buildMs", "buildMs"]]) +
        '<p class="stcaption">Each extra hop adds two link crossings plus one more layer of crypto. Circuit setup grows faster because every hop needs a key exchange.</p>';
    $("sweep").disabled = false;
    $("sweep").textContent = "Run latency sweep";
}

for (const box of document.querySelectorAll(".slider")) {
    buildSlider(box);
}
$("killOn").addEventListener("change", syncSidebar);
$("run").addEventListener("click", runClicked);
$("sweep").addEventListener("click", sweepClicked);

$("tabs").addEventListener("click", e => {
    const tab = e.target.dataset.tab;
    if (!tab) {
        return;
    }
    for (const button of document.querySelectorAll("#tabs button")) {
        button.classList.toggle("active", button === e.target);
    }
    for (const section of document.querySelectorAll(".tab")) {
        section.hidden = section.id !== "tab-" + tab;
    }
});

syncSidebar();
runClicked();
