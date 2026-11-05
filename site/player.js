// Step-by-step onion player: keyed SVG shapes that glide from one step to the next.
// mountPlayer(root, data) builds the whole widget inside `root`; data comes from Scene.buildPlayerData.
// Used by the GitHub Pages site and inlined into the Streamlit dashboard.

function mountPlayer(root, data) {
    /* Input  : an empty element, the output of Scene.buildPlayerData
       Output : { show, stop, play, destroy, setTween, current } */
    const NS = "http://www.w3.org/2000/svg";
    const steps = data.steps;
    const last = steps.length - 1;

    // ---------- Widget skeleton ----------
    root.classList.add("op-player");
    root.innerHTML =
        '<div class="op-bar">' +
        '<button class="op-back" title="Previous step">&#9664; Back</button>' +
        '<button class="op-play op-primary">Pause</button>' +
        '<button class="op-next" title="Next step">Next &#9654;</button>' +
        '<input type="range" class="op-slider" min="0" max="0" value="0">' +
        '<span class="op-count"></span>' +
        '<select class="op-speed" title="Playback speed"><option value="0.5">0.5x</option><option value="1" selected>1x</option><option value="2">2x</option></select>' +
        '</div>' +
        '<svg class="op-stage" viewBox="-1.7 -9.4 19 11" preserveAspectRatio="xMidYMid meet"></svg>' +
        '<div class="op-legend">Filled white = you &middot; white ring = relay &middot; green = destination &middot; dotted arc from you = key exchange with that relay &middot; ' +
        'solid arc = key agreed &middot; thin white line = connection between relays (bright = "told to extend") &middot; rings around you = keys you wrap with, ' +
        'newest outermost &middot; faded = relay not used &middot; red = something failed</div>' +
        '<div class="op-detail"><div class="op-card"><div class="op-meta"></div><div class="op-text"></div><div class="op-why"></div></div>' +
        '<svg class="op-section" viewBox="-1.15 -1.25 2.3 2.4"></svg></div>' +
        '<div class="op-logtitle">Full log</div>' +
        '<div class="op-log"><table><thead><tr><th>step</th><th>t (ms)</th><th>who</th><th>what</th></tr></thead><tbody class="op-logbody"></tbody></table></div>';
    const $ = cls => root.querySelector("." + cls);
    const stage = $("op-stage");
    const slider = $("op-slider");
    const playButton = $("op-play");

    // ---------- Scene engine ----------
    const layers = [];
    for (let z = 0; z < 10; z++) {
        const g = document.createElementNS(NS, "g");
        stage.appendChild(g);
        layers.push(g);
    }
    const shapes = new Map();       // key -> shape
    let tweenMs = 700;
    let tweenStart = 0;
    let raf = null;

    function make(tag) {
        return document.createElementNS(NS, tag);
    }

    function createShape(p) {
        // A new shape fades in (circles pop out, links grow from their start)
        const o = { type: p.t, key: p.k, dying: false, from: {}, tgt: {} };
        const g = layers[p.z];
        if (p.t === "c") {
            o.el = make("circle");
            o.cur = { x: p.x, y: p.y, r: p.r * 0.6, sw: p.sw, op: 0, fo: p.fo };
            g.appendChild(o.el);
        } else if (p.t === "l") {
            o.glow = make("path");
            o.line = make("path");
            o.head = make("polygon");
            for (const part of [o.glow, o.line]) {
                part.setAttribute("fill", "none");
                part.setAttribute("stroke-linecap", "round");
                g.appendChild(part);
            }
            g.appendChild(o.head);
            o.cur = { x1: p.x1, y1: p.y1, x2: p.x1, y2: p.y1, sw: p.sw, op: 0, bend: p.bend };
        } else {
            o.el = make("text");
            o.cur = { x: p.x, y: p.y, op: 0 };
            g.appendChild(o.el);
        }
        shapes.set(p.k, o);
        return o;
    }

    function setTarget(o, p) {
        // Numbers are tweened, colours / dashes are set right away (CSS transitions fade the colours)
        o.from = Object.assign({}, o.cur);
        o.dying = false;
        if (p.t === "c") {
            o.tgt = { x: p.x, y: p.y, r: p.r, sw: p.sw, op: p.op, fo: p.fo };
            o.el.style.stroke = p.stroke || "none";
            o.el.style.fill = p.fill || "none";
            o.el.setAttribute("stroke-dasharray", p.dash ? "0.14 0.14" : "none");
            o.el.style.filter = p.glow ? "drop-shadow(0 0 5px " + (p.stroke || p.fill) + ")" : "none";
        } else if (p.t === "l") {
            o.tgt = { x1: p.x1, y1: p.y1, x2: p.x2, y2: p.y2, sw: p.sw, op: p.op, bend: p.bend };
            o.line.style.stroke = p.color;
            o.glow.style.stroke = p.color;
            o.head.style.fill = p.color;
            if (p.dotted) {
                o.line.setAttribute("stroke-dasharray", "0.01 0.26");
                o.line.setAttribute("class", "op-march");
            } else {
                o.line.setAttribute("stroke-dasharray", "none");
                o.line.removeAttribute("class");
            }
            o.dotted = p.dotted;
        } else {
            o.tgt = { x: p.x, y: p.y, op: p.op };
            o.el.textContent = p.s;
            o.el.style.fill = p.fill;
            o.el.setAttribute("font-size", p.size);
            o.el.setAttribute("font-weight", p.weight);
            o.el.setAttribute("text-anchor", "middle");
        }
    }

    function render(o) {
        const c = o.cur;
        if (o.type === "c") {
            o.el.setAttribute("cx", c.x);
            o.el.setAttribute("cy", -c.y);
            o.el.setAttribute("r", Math.max(c.r, 0));
            o.el.setAttribute("stroke-width", c.sw * 0.03);
            o.el.setAttribute("opacity", c.op);
            o.el.setAttribute("fill-opacity", c.fo);
        } else if (o.type === "l") {
            // Quadratic curve; the control point sits to the left of the direction of travel (scene coordinates, y up)
            const dx = c.x2 - c.x1;
            const dy = c.y2 - c.y1;
            const len = Math.hypot(dx, dy);
            const cx = (c.x1 + c.x2) / 2 + (-dy / Math.max(len, 0.001)) * c.bend * len;
            const cy = (c.y1 + c.y2) / 2 + (dx / Math.max(len, 0.001)) * c.bend * len;
            const d = "M " + c.x1 + " " + (-c.y1) + " Q " + cx + " " + (-cy) + " " + c.x2 + " " + (-c.y2);
            o.line.setAttribute("d", d);
            o.glow.setAttribute("d", d);
            o.line.setAttribute("stroke-width", c.sw * 0.03);
            o.glow.setAttribute("stroke-width", c.sw * 0.12);
            o.line.setAttribute("opacity", c.op);
            o.glow.setAttribute("opacity", o.dotted ? c.op * 0.1 : c.op * 0.22);
            if (len < 0.7) {
                o.head.setAttribute("points", "");
            } else {
                // The arrowhead follows the tangent at the end of the curve
                const tx = c.x2 - cx;
                const ty = -(c.y2 - cy);
                const tl = Math.max(Math.hypot(tx, ty), 0.001);
                const ux = tx / tl;
                const uy = ty / tl;
                const bx = c.x2;
                const by = -c.y2;
                const bxs = bx - ux * 0.5;
                const bys = by - uy * 0.5;
                o.head.setAttribute("points", bx + "," + by + " " + (bxs - uy * 0.2) + "," + (bys + ux * 0.2) + " " + (bxs + uy * 0.2) + "," + (bys - ux * 0.2));
            }
            o.head.setAttribute("opacity", c.op);
        } else {
            o.el.setAttribute("x", c.x);
            o.el.setAttribute("y", -c.y);
            o.el.setAttribute("opacity", c.op);
        }
    }

    function removeDying() {
        for (const [key, o] of Array.from(shapes)) {
            if (o.dying) {
                for (const part of [o.el, o.line, o.glow, o.head]) {
                    if (part) {
                        part.remove();
                    }
                }
                shapes.delete(key);
            }
        }
    }

    function tick(now) {
        const t = Math.min((now - tweenStart) / tweenMs, 1);
        const e = 1 - Math.pow(1 - t, 3);
        for (const o of shapes.values()) {
            for (const key in o.tgt) {
                o.cur[key] = o.from[key] + (o.tgt[key] - o.from[key]) * e;
            }
            render(o);
        }
        if (t < 1) {
            raf = requestAnimationFrame(tick);
            return;
        }
        raf = null;
        removeDying();
    }

    function applyScene(prims, instant) {
        // Update shapes that exist, create new ones, fade out the ones that are gone
        const seen = new Set();
        for (const p of prims) {
            seen.add(p.k);
            const o = shapes.get(p.k) || createShape(p);
            setTarget(o, p);
        }
        for (const o of shapes.values()) {
            if (!seen.has(o.key)) {
                o.from = Object.assign({}, o.cur);
                o.tgt = Object.assign({}, o.cur, { op: 0 });
                o.dying = true;
            }
        }
        if (instant) {
            for (const o of shapes.values()) {
                o.cur = Object.assign({}, o.tgt);
                render(o);
            }
            removeDying();
            return;
        }
        tweenStart = performance.now();
        if (raf !== null) {
            cancelAnimationFrame(raf);
        }
        raf = requestAnimationFrame(tick);
    }

    // ---------- Onion cross-section ----------
    function drawSection(sec) {
        const svg = $("op-section");
        svg.innerHTML = "";
        if (sec.rings.length === 0) {
            const t = make("text");
            t.setAttribute("text-anchor", "middle");
            t.setAttribute("font-size", "0.16");
            t.style.fill = "#98a1b8";
            t.textContent = "No packet yet";
            svg.appendChild(t);
            return;
        }
        const n = sec.rings.length;
        const band = 0.7 / n;
        sec.rings.forEach((ring, j) => {
            const r = 1 - j * band;
            const c = make("circle");
            c.setAttribute("r", r);
            c.style.stroke = ring.c;
            if (ring.peeled) {
                c.setAttribute("fill", "none");
                c.setAttribute("stroke-dasharray", "0.06 0.06");
                c.setAttribute("opacity", "0.45");
                c.setAttribute("stroke-width", "0.025");
            } else {
                c.style.fill = ring.c;
                c.setAttribute("fill-opacity", "0.35");
                c.setAttribute("stroke-width", "0.04");
            }
            svg.appendChild(c);
            const t = make("text");
            const font = Math.min(0.11, band * 0.7);       // many rings = thinner bands = smaller names
            t.setAttribute("text-anchor", "middle");
            t.setAttribute("font-size", font);
            t.setAttribute("font-weight", "700");
            t.setAttribute("y", -(r - band / 2) + font * 0.36);
            t.style.fill = ring.peeled ? "#98a1b8" : "#e8eaf2";
            t.textContent = ring.owner;
            svg.appendChild(t);
        });
        const core = make("circle");
        core.setAttribute("r", 1 - n * band + 0.05);
        core.style.fill = sec.plain ? "#ffd166" : "#ffffff";
        svg.appendChild(core);
        const m = make("text");
        m.setAttribute("text-anchor", "middle");
        m.setAttribute("font-size", "0.1");
        m.setAttribute("font-weight", "700");
        m.setAttribute("y", 0.035);
        m.style.fill = "#111";
        m.textContent = "msg";
        svg.appendChild(m);
    }

    // ---------- Playback ----------
    let current = -1;
    let timer = null;
    let startTimer = null;

    function show(i) {
        current = Math.max(0, Math.min(i, last));
        const s = steps[current];
        applyScene(s.prims, false);
        drawSection(s.sec);
        slider.value = current;
        $("op-count").textContent = "step " + current + " / " + last;
        $("op-meta").textContent = "t = " + s.t + " ms  ·  " + s.who;
        $("op-text").textContent = s.text;
        $("op-why").textContent = s.why;
        const bad = ["killed", "request_failed", "rebuild_start", "dead_found", "build_failed", "heartbeat_failed", "giving_up", "drop", "error"].includes(s.kind);
        $("op-card").classList.toggle("op-bad", bad);

        // Highlight the current row of the full log and keep it in the middle of the log box
        for (const row of root.querySelectorAll(".op-logbody tr")) {
            row.classList.toggle("op-now", +row.dataset.step === current);
        }
        const box = $("op-log");
        const row = root.querySelector(".op-logbody tr.op-now");
        if (row) {
            box.scrollTop = row.offsetTop - box.clientHeight / 2 + row.clientHeight / 2;
        }
    }

    function stop() {
        if (timer !== null) {
            clearInterval(timer);
            timer = null;
        }
        playButton.textContent = (current >= last) ? "Replay" : "Play";
    }

    function intervalMs() {
        return 1500 / +$("op-speed").value;
    }

    function play() {
        if (current >= last) {
            replay();
            return;
        }
        tweenMs = Math.min(700, intervalMs() * 0.6);
        playButton.textContent = "Pause";
        timer = setInterval(() => {
            if (current >= last) {
                stop();
            } else {
                show(current + 1);
                if (current >= last) {
                    stop();
                }
            }
        }, intervalMs());
    }

    function replay() {
        // Back to the scattered start, then drift again
        stop();
        applyScene(data.intro, true);
        current = -1;
        startTimer = setTimeout(() => { show(0); play(); }, 500);
    }

    function jump(i, ms) {
        // Manual navigation: pause, then move with a short glide
        stop();
        tweenMs = ms;
        show(i);
    }

    playButton.addEventListener("click", () => { timer === null ? play() : stop(); });
    $("op-back").addEventListener("click", () => jump(current - 1, 600));
    $("op-next").addEventListener("click", () => jump(current + 1, 600));
    slider.addEventListener("input", () => jump(+slider.value, 450));
    $("op-speed").addEventListener("change", () => { if (timer !== null) { stop(); play(); } });

    // ---------- Full log ----------
    const body = $("op-logbody");
    steps.forEach((s, i) => {
        const tr = document.createElement("tr");
        tr.dataset.step = i;
        for (const text of [i, s.t, s.who, s.text]) {
            const td = document.createElement("td");
            td.textContent = text;
            tr.appendChild(td);
        }
        tr.addEventListener("click", () => jump(i, 600));
        body.appendChild(tr);
    });

    // ---------- Start : scattered nodes first, then they drift into line ----------
    slider.max = last;
    applyScene(data.intro, true);
    startTimer = setTimeout(() => { show(0); play(); }, 900);

    function destroy() {
        // Stop every timer before the widget is replaced
        stop();
        clearTimeout(startTimer);
        if (raf !== null) {
            cancelAnimationFrame(raf);
        }
        root.innerHTML = "";
    }

    return {
        show: show, stop: stop, play: play, destroy: destroy,
        setTween: ms => { tweenMs = ms; },
        current: () => current,
        shapeCount: () => shapes.size,
    };
}
