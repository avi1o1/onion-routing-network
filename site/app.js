// Dashboard UI: reads the sliders, runs Sim, draws everything.

// ---------- Small helpers ----------
const $ = id => document.getElementById(id);
let run = null;       // result of the last experiment
let sweepRows = null; // result of the last latency sweep

function esc(text) {
    // Escape text before putting it in HTML
    return String(text).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function table(rows, columns, monoColumns) {
    // Helper function to turn a list of objects into an HTML table
    let html = '<div class="tablewrap"><table><tr>';
    for (const col of columns) {
        html += "<th>" + esc(col[1]) + "</th>";
    }
    html += "</tr>";
    for (const row of rows) {
        html += "<tr>";
        for (const col of columns) {
            let value = row[col[0]];
            let cls = (monoColumns || []).includes(col[0]) ? "mono" : "";
            if (value === true) {
                value = "yes";
                cls += " yes";
            } else if (value === false) {
                value = "no";
            } else if (value === null || value === undefined) {
                value = "";
            }
            html += '<td class="' + cls + '">' + esc(value) + "</td>";
        }
        html += "</tr>";
    }
    return html + "</table></div>";
}

function describe(e) {
    // One log event as a plain-English sentence
    const k = e.kind;
    if (k === "build") return "Client picked relays " + e.names.join(", ") + " from the directory";
    if (k === "hop_added") return "Circuit extended: client -> " + e.path.join(" -> ");
    if (k === "circuit_ready") return "Circuit ready (" + e.buildMs.toFixed(0) + " ms to build)";
    if (k === "wrap") return "Client wrapped " + e.cmd + " in " + e.layers.length + " encryption layer(s)";
    if (k === "create") return e.who + " did a key exchange with " + e.prev;
    if (k === "extend") return e.who + " was told to extend to " + e.next;
    if (k === "linked") return e.who + " opened a link to " + e.next;
    if (k === "peel") return e.who + " peeled its layer (" + e.inSize + " -> " + e.outSize + " bytes) and forwarded it";
    if (k === "exit") return e.who + " (exit) sends '" + e.payload + "' to " + e.dest;
    if (k === "ping") return e.who + " (last hop) answered a heartbeat ping";
    if (k === "drop") return e.who + " dropped a cell (packet loss)";
    if (k === "request") return "Destination got '" + e.payload + "' from " + e.prev + " (the exit relay)";
    if (k === "response") return "Client received the reply in " + e.latencyMs.toFixed(0) + " ms";
    if (k === "killed") return e.name + " CRASHED";
    if (k === "request_failed") return "Request attempt " + e.attempt + " failed: " + e.detail;
    if (k === "rebuild_start") return "Client is rebuilding the circuit";
    if (k === "dead_found") return "Client found dead relays: " + (e.dead.length ? e.dead.join(", ") : "none");
    if (k === "build_failed") return "Circuit build failed: " + e.detail;
    if (k === "heartbeat_failed") return "Heartbeat failed, rebuilding";
    if (k === "giving_up") return "Request failed (no more retries)";
    return k;
}

// ---------- Controls ----------
function readConfig() {
    const killOn = $("killOn").checked;
    return {
        hops: +$("hops").value,
        relays: +$("pool").value,
        delayMs: +$("delay").value,
        lossPct: +$("loss").value,
        requests: +$("reqs").value,
        timeoutMs: +$("timeout").value,
        killAt: killOn ? +$("killAt").value : null,
        killHop: +$("killHop").value - 1,
        retry: document.querySelector("input[name=policy]:checked").value === "retry",
        heartbeat: $("heartbeat").checked,
    };
}

function syncControls() {
    // Keep dependent sliders in range and show the numbers next to them
    $("killAt").max = Math.max(+$("reqs").value - 1, 0);
    $("killHop").max = +$("hops").value;
    for (const id of ["hops", "pool", "delay", "loss", "reqs", "timeout", "killAt", "killHop"]) {
        $(id + "Out").textContent = $(id).value;
    }
    $("warn").hidden = +$("pool").value >= +$("hops").value + 1;
}

// ---------- Network drawing ----------
function relayPositions(names) {
    const pos = { client: [60, 220], destination: [740, 220] };
    for (let i = 0; i < names.length; i++) {
        const angle = (2 * Math.PI * i) / names.length + Math.PI / 2;
        pos[names[i]] = [400 + 230 * Math.cos(angle), 220 + 165 * Math.sin(angle)];
    }
    return pos;
}

function stateAtStep(events, step) {
    // Replay the log: current circuit path and dead relays
    let path = [];
    const dead = [];
    for (let i = 0; i <= step; i++) {
        if (events[i].who === "client" && events[i].path !== undefined) {
            path = events[i].path;
        }
        if (events[i].kind === "killed") {
            dead.push(events[i].name);
        }
    }
    return { path: path, dead: dead };
}

function drawNetwork(step) {
    const events = run.events;
    const pos = relayPositions(run.relayNames);
    const state = stateAtStep(events, step);
    const active = events[step].who;

    let svg = '<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">' +
              '<path d="M0,0 L10,5 L0,10 z" fill="var(--blue)"/></marker></defs>';

    // Circuit edges, shortened so the arrow stops at the node edge
    const chain = ["client"].concat(state.path);
    if (state.path.length > 0) {
        chain.push("destination");
    }
    for (let i = 0; i < chain.length - 1; i++) {
        const a = pos[chain[i]];
        const b = pos[chain[i + 1]];
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const ux = (b[0] - a[0]) / len;
        const uy = (b[1] - a[1]) / len;
        svg += '<line x1="' + (a[0] + ux * 22) + '" y1="' + (a[1] + uy * 22) + '" x2="' + (b[0] - ux * 26) + '" y2="' + (b[1] - uy * 26) +
               '" stroke="var(--blue)" stroke-width="2.5" marker-end="url(#arrow)"/>';
    }

    // Nodes
    for (const name in pos) {
        const p = pos[name];
        let color = "var(--grey)";
        if (state.path.includes(name) || name === "client" || name === "destination") {
            color = "var(--blue)";
        }
        if (state.dead.includes(name)) {
            color = "var(--red)";
        }
        const ring = (name === active) ? ' stroke="var(--text)" stroke-width="3"' : "";
        svg += '<circle cx="' + p[0] + '" cy="' + p[1] + '" r="' + (name === active ? 19 : 15) + '" fill="' + color + '"' + ring + "/>";
        if (state.dead.includes(name)) {
            svg += '<text x="' + p[0] + '" y="' + (p[1] + 4) + '" text-anchor="middle" style="fill:#fff;font-weight:700">X</text>';
        }
        let label = name;
        if (state.path.includes(name)) {
            label += " (hop " + (state.path.indexOf(name) + 1) + ")";
        }
        svg += '<text x="' + p[0] + '" y="' + (p[1] + 34) + '" text-anchor="middle">' + esc(label) + "</text>";
    }
    $("net").innerHTML = svg;
}

function renderStep() {
    const step = +$("step").value;
    const events = run.events;
    drawNetwork(step);
    $("stepTitle").textContent = "Step " + step;
    $("stepText").textContent = describe(events[step]);
    const rows = [];
    for (let i = Math.max(0, step - 9); i <= step; i++) {
        rows.push({ t: Math.round(events[i].t), who: events[i].who, what: describe(events[i]) });
    }
    $("stepTable").innerHTML = table(rows, [["t", "t (ms)"], ["who", "who"], ["what", "what"]]);
}

// ---------- Charts (plain SVG) ----------
function barChart(results) {
    const w = 700, h = 240, left = 50, bottom = 30;
    const max = Math.max(...results.map(r => r.latencyMs), 1);
    const slot = (w - left) / results.length;
    let svg = '<svg viewBox="0 0 ' + w + " " + h + '">';
    for (let i = 0; i < results.length; i++) {
        const r = results[i];
        let color = "var(--green)";
        if (!r.ok) {
            color = "var(--red)";
        } else if (r.attempts > 1) {
            color = "var(--orange)";
        }
        const barH = (r.latencyMs / max) * (h - bottom - 20);
        const x = left + i * slot + slot * 0.15;
        svg += '<rect x="' + x + '" y="' + (h - bottom - barH) + '" width="' + slot * 0.7 + '" height="' + barH + '" fill="' + color + '"/>';
        svg += '<text x="' + (x + slot * 0.35) + '" y="' + (h - 10) + '" text-anchor="middle">' + i + "</text>";
    }
    svg += '<text x="6" y="16">' + max.toFixed(0) + ' ms</text><text x="6" y="' + (h - bottom) + '">0</text></svg>';
    return svg;
}

function lineChart(xs, series) {
    // series: list of {name, color, values}
    const w = 700, h = 280, left = 55, bottom = 35, top = 20;
    const max = Math.max(...series.flatMap(s => s.values), 1);
    const px = i => left + (i / Math.max(xs.length - 1, 1)) * (w - left - 20);
    const py = v => h - bottom - (v / max) * (h - bottom - top);
    let svg = '<svg viewBox="0 0 ' + w + " " + h + '">';
    svg += '<line x1="' + left + '" y1="' + py(0) + '" x2="' + (w - 10) + '" y2="' + py(0) + '" stroke="var(--line)"/>';
    for (let i = 0; i < xs.length; i++) {
        svg += '<text x="' + px(i) + '" y="' + (h - 12) + '" text-anchor="middle">' + xs[i] + " hops</text>";
    }
    svg += '<text x="6" y="' + (top + 4) + '">' + max.toFixed(0) + " ms</text>";
    series.forEach((s, k) => {
        let points = "";
        for (let i = 0; i < xs.length; i++) {
            points += px(i) + "," + py(s.values[i]) + " ";
            svg += '<circle cx="' + px(i) + '" cy="' + py(s.values[i]) + '" r="4" fill="' + s.color + '"/>';
        }
        svg += '<polyline points="' + points + '" fill="none" stroke="' + s.color + '" stroke-width="2.5"/>';
        svg += '<text x="' + (left + 10 + k * 170) + '" y="' + top + '" style="fill:' + s.color + '">' + s.name + "</text>";
    });
    return svg + "</svg>";
}

// ---------- Rendering all tabs ----------
function renderMetrics() {
    const ok = run.results.filter(r => r.ok);
    let mean = 0;
    for (const r of ok) {
        mean += r.latencyMs;
    }
    mean = ok.length ? mean / ok.length : 0;
    const retried = run.results.filter(r => r.attempts > 1).length;
    const cards = [["Succeeded", ok.length + " / " + run.results.length], ["Mean latency", mean.toFixed(0) + " ms"],
                   ["Circuit build", run.buildMs !== null ? run.buildMs.toFixed(0) + " ms" : "-"], ["Retried requests", retried]];
    $("metrics").innerHTML = cards.map(c => '<div class="metric"><span>' + c[0] + "</span><b>" + c[1] + "</b></div>").join("");
}

function renderLayers() {
    const events = run.events;
    let wrapIndex = events.findIndex(e => e.kind === "wrap" && e.cmd === "REQUEST");
    if (wrapIndex < 0) {
        $("wrapTable").textContent = "No request was sent.";
        $("peelTable").textContent = "";
        return;
    }
    const layers = events[wrapIndex].layers.map(l => ({ hop: l.hop, size: l.size, prefix: l.prefix }));
    $("wrapTable").innerHTML = table(layers, [["hop", "layer for"], ["size", "ciphertext size (bytes)"], ["prefix", "first bytes"]], ["prefix"]);

    const peels = [];
    for (let i = wrapIndex + 1; i < events.length && events[i].who !== "client"; i++) {
        const e = events[i];
        if (e.kind === "peel") {
            peels.push({ relay: e.who, received: e.inPrefix, after: e.outPrefix, sizeIn: e.inSize, sizeOut: e.outSize });
        }
        if (e.kind === "exit") {
            peels.push({ relay: e.who + " (exit)", received: "", after: "plaintext: " + e.payload, sizeIn: null, sizeOut: null });
        }
    }
    $("peelTable").innerHTML = table(peels, [["relay", "relay"], ["received", "received"], ["after", "after peeling"], ["sizeIn", "size in"], ["sizeOut", "size out"]], ["received", "after"]);
}

function renderFailures() {
    $("failChart").innerHTML = barChart(run.results);
    const detail = run.results.map(r => ({ index: r.index, ok: r.ok, latency: Math.round(r.latencyMs), attempts: r.attempts, rebuilt: r.rebuilt, error: r.error }));
    $("failTable").innerHTML = table(detail, [["index", "request"], ["ok", "ok"], ["latency", "latency (ms)"], ["attempts", "attempts"], ["rebuilt", "circuit rebuilt"], ["error", "error"]]);

    const interesting = ["killed", "request_failed", "rebuild_start", "dead_found", "build_failed", "heartbeat_failed", "circuit_ready", "giving_up", "drop"];
    const timeline = run.events.filter(e => interesting.includes(e.kind)).map(e => ({ t: Math.round(e.t), who: e.who, what: describe(e) }));
    $("failTimeline").innerHTML = table(timeline, [["t", "t (ms)"], ["who", "who"], ["what", "what"]]);
}

function renderSaw() {
    const full = run.events.find(e => e.who === "client" && e.kind === "hop_added" && e.path.length === run.config.hops);
    if (!full) {
        $("circuitLine").textContent = "No complete circuit was built.";
        $("sawTable").innerHTML = "";
        $("claims").innerHTML = "";
        return;
    }
    $("circuitLine").textContent = "Circuit: client (" + full.clientAddr + ") -> " + full.path.join(" -> ") + " -> destination (" + run.destAddr + ")";
    const rows = Sim.whatEachHopSaw(run.events, full.path, full.clientAddr);
    $("sawTable").innerHTML = table(rows, [["relay", "relay"], ["position", "position"], ["knowsClient", "knows client address"], ["knowsNextHop", "knows next hop"],
                                           ["knowsDestination", "knows destination"], ["seesPlaintext", "sees plaintext"]]);
    $("claims").innerHTML = Sim.checkClaims(rows).map(c => '<div class="claim ' + (c[1] ? "ok" : "bad") + '">' + (c[1] ? "Holds: " : "Broken: ") + esc(c[0]) + "</div>").join("");
}

function renderSweep() {
    if (sweepRows === null) {
        return;
    }
    const hopsList = [1, 2, 3, 4, 5];
    const lat = [];
    const build = [];
    for (const h of hopsList) {
        const rows = sweepRows.filter(r => r.hops === h);
        lat.push(rows.reduce((a, r) => a + r.latencyMs, 0) / rows.length);
        build.push(rows.reduce((a, r) => a + r.buildMs, 0) / rows.length);
    }
    const chart = lineChart(hopsList, [{ name: "request latency", color: "var(--blue)", values: lat },
                                       { name: "circuit build time", color: "var(--red)", values: build }]);
    const rows = hopsList.map((h, i) => ({ hops: h, latency: lat[i].toFixed(1), build: build[i].toFixed(1) }));
    $("sweepOut").innerHTML = chart + table(rows, [["hops", "hops"], ["latency", "mean latency (ms)"], ["build", "mean build time (ms)"]]) +
        '<p class="note">Each extra hop adds two link crossings plus one more layer of crypto. Circuit setup grows faster because every hop needs a key exchange. (The first request of each run includes the build time.)</p>';
}

function renderAll() {
    renderMetrics();
    $("step").max = run.events.length - 1;
    $("step").value = 0;
    renderStep();
    renderLayers();
    renderFailures();
    renderSaw();
}

// ---------- Events ----------
async function runClicked() {
    $("run").disabled = true;
    run = await Sim.runExperiment(readConfig());
    renderAll();
    $("run").disabled = false;
}

async function sweepClicked() {
    $("sweep").disabled = true;
    $("sweep").textContent = "Running...";
    const config = Object.assign({}, readConfig(), { requests: 8, heartbeat: false, killAt: null });
    sweepRows = await Sim.sweepHops(config, [1, 2, 3, 4, 5], 2);
    renderSweep();
    $("sweep").disabled = false;
    $("sweep").textContent = "Run latency sweep";
}

for (const id of ["hops", "pool", "delay", "loss", "reqs", "timeout", "killAt", "killHop"]) {
    $(id).addEventListener("input", syncControls);
}
$("step").addEventListener("input", renderStep);
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

syncControls();
runClicked();
