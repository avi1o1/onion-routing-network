// Turns a run's event log into what the player shows at every step: keyed shapes, captions, cross-section.
// Shared by the GitHub Pages site and the Streamlit dashboard (which inlines this very file),
// so both draw exactly the same picture from their events.

const Scene = (() => {
    // ---------- Constants ----------
    const CLIENT_POS = [0.4, 4.6];      // the network is drawn on a 19 x 11 canvas
    const DEST_POS = [16.2, 4.6];
    const DARK_BG = "#0c0e16";          // dark canvas so the glowing rings stand out
    const MUTED = "#98a1b8";
    const RING_COLORS = ["#7c5cff", "#2fc4b2", "#f0a64a", "#e86fd0", "#5b95f0"];   // ring colour = the hop whose key opens it
    const ALERT = "#ff4d4d";            // everything that went wrong is drawn in this red
    const WHITE = "#ffffff";
    const PLAIN = "#ffd166";            // a message that is readable (no layers left)
    const DEST_GREEN = "#4cc07f";
    const FAIL_KINDS = ["request_failed", "build_failed", "heartbeat_failed", "giving_up"];   // source gets a red outer ring
    const FIELDS = ["kind", "who", "t", "names", "path", "cmd", "layers", "inSize", "outSize", "payload",
                    "name", "attempt", "detail", "dead", "buildMs", "latencyMs"];          // all the player ever reads

    // One line of "why does this matter" under each step
    const WHY = {
        build: "The client picks relays at random from the directory, so nobody chooses the path for it.",
        create: "A fresh key pair: the key is agreed between you and this relay and never crosses the wire (dotted arc from you = exchange in progress). The first relay is reached directly; every later one only through the circuit, so it never sees your address.",
        hop_added: "The key is agreed, so the dotted arc turns solid. The client now holds one more key.",
        wrap: "One layer of encryption per hop. The client's rings are the keys it holds, newest on the outside.",
        extend: "The last relay is told to connect to the next one (white line), and learns nothing about the rest of the path.",
        linked: "The relay opens a connection to the next hop and from now on forwards blindly.",
        circuit_ready: "Every relay shares a key with the client, and knows only its two neighbours.",
        peel: "A relay can remove exactly one layer. What is left is ciphertext it cannot read.",
        exit: "The exit relay sees the request and the destination, but not who sent it.",
        request: "The destination only ever sees the exit relay, never the client.",
        response: "The reply came back through the same relays, each adding its layer. The client removed them all.",
        ping: "The heartbeat travels the whole circuit to notice a dead relay early.",
        drop: "The cell never arrived. The client only finds out when its timeout runs out.",
        killed: "A relay died. Nobody tells the client: it finds out when something stops answering.",
        request_failed: "Any timeout, closed link or bad tag means the circuit is broken: one dead link breaks the chain.",
        rebuild_start: "A broken circuit cannot be patched, so the client discards it and builds a new one.",
        dead_found: "Dead relays are removed from the directory so they are not picked again.",
        build_failed: "The new circuit hit another dead relay. The client tries again with the survivors.",
        heartbeat_failed: "The heartbeat caught the failure before any real request had to fail.",
        giving_up: "After the allowed retry the client returns a clear error instead of hanging.",
        error: "A relay rejected a cell it could not authenticate.",
    };

    // ---------- Small helpers ----------
    function cleanText(text) {
        // No IPs or ports in anything the user reads, relays are only ever R1, R2, ...
        return String(text).replace(/127\.0\.0\.1:\d+/g, "a relay");
    }

    function slimEvents(events) {
        // Keep only the fields the player reads (drops every address), layers keep only their relay name
        const out = [];
        for (const e of events) {
            const s = {};
            for (const f of FIELDS) {
                if (e[f] !== undefined) {
                    s[f] = e[f];
                }
            }
            if (s.layers !== undefined) {
                s.layers = s.layers.map(l => ({ hop: l.hop }));
            }
            if (s.detail !== undefined) {
                s.detail = cleanText(s.detail);
            }
            out.push(s);
        }
        return out;
    }

    function whoLabel(who) {
        // 'client' -> 'Client', relays stay R1, R2, ...
        if (who === "client" || who === "destination" || who === "experiment") {
            return who.charAt(0).toUpperCase() + who.slice(1);
        }
        return who;
    }

    function plural(n, word) {
        return n + " " + word + (n !== 1 ? "S" : "");
    }

    function mulberry32(seed) {
        // Helper function: tiny seeded random generator, so the scatter is the same every time
        return function () {
            seed |= 0;
            seed = (seed + 0x6D2B79F5) | 0;
            let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    // ---------- Layout ----------
    function scatterPositions(names) {
        // Fixed pseudo-random spots for the relays, kept out of the middle band where the circuit line will be
        const rand = mulberry32(names.length * 101 + 7);
        const spots = {};
        const placed = [];
        for (const name of names) {
            let x = 8.0;
            let y = 1.0;
            for (let attempt = 0; attempt < 300; attempt++) {
                x = 2.8 + rand() * 10.4;
                y = 1.0 + rand() * 7.2;
                if (Math.abs(y - CLIENT_POS[1]) < 1.9) {
                    continue;
                }
                let free = true;
                for (const p of placed) {
                    if (Math.hypot(x - p[0], y - p[1]) <= 2.0) {
                        free = false;
                    }
                }
                if (free) {
                    break;
                }
            }
            spots[name] = [x, y];
            placed.push([x, y]);
        }
        return spots;
    }

    function ringStep(run) {
        // Gap between two key rings (around the source and on the onion packet). 5 hops squeeze them.
        return Math.min(0.22, 0.6 / Math.max(run.hops, 1));
    }

    function sourceReach(run) {
        // The furthest the source's rings can ever reach (all keys + the red failure ring)
        return 0.8 + ringStep(run) * (Math.max(run.hops, 1) - 1) + 0.5;
    }

    function layoutAt(run, step) {
        /* Where every node sits once the log has been replayed up to `step`.
           Relays the client picked stand on a line between source and destination, the others stay scattered.
           step = -1 means before anything happened: everybody scattered. */
        const positions = scatterPositions(run.relayNames);
        positions.client = CLIENT_POS;
        positions.destination = DEST_POS;
        let chosen = [];
        for (const e of run.events.slice(0, step + 1)) {
            if (e.kind === "build") {
                chosen = e.names;
            }
        }
        // The line starts just after the source's biggest possible ring and ends before the destination
        const firstX = CLIENT_POS[0] + sourceReach(run) + 1.3;
        const lastX = DEST_POS[0] - 2.1;
        for (let i = 0; i < chosen.length; i++) {
            let x = (firstX + lastX) / 2;
            if (chosen.length > 1) {
                x = firstX + (lastX - firstX) * i / (chosen.length - 1);
            }
            positions[chosen[i]] = [x, CLIENT_POS[1]];
        }
        return positions;
    }

    // ---------- Replaying the log ----------
    function circuitState(events, step) {
        /* Relays picked, hops with an agreed key (path), the hop whose key exchange is
           still going on (pending), crashed relays and whether the circuit is ready. */
        const state = { chosen: [], path: [], pending: null, dead: [], ready: false };
        for (const e of events.slice(0, step + 1)) {
            if (e.kind === "build") {
                state.chosen = e.names;
                state.path = [];
                state.pending = null;
                state.ready = false;
            } else if (e.kind === "create") {
                state.pending = e.who;
            } else if (e.kind === "hop_added") {
                state.path = e.path;
                state.pending = null;
            } else if (e.kind === "circuit_ready") {
                state.ready = true;
            } else if (e.kind === "killed") {
                state.dead.push(e.name);
            }
        }
        return state;
    }

    function stateAtStep(events, step) {
        // Current circuit path and dead relays (as the client last reported them)
        let path = [];
        const dead = [];
        for (const e of events.slice(0, step + 1)) {
            if (e.who === "client" && e.path !== undefined) {
                path = e.path;
            }
            if (e.kind === "killed") {
                dead.push(e.name);
            }
        }
        return { path: path, dead: dead };
    }

    function onionState(events, step) {
        /* How many layers the packet still carries (null = no packet is moving at this step)
           and which relay owns each ring (outermost first). */
        if (step < 0) {
            return { path: [], dead: [], total: 0, owners: [], layers: null, peeled: false };
        }
        const now = stateAtStep(events, step);
        const path = now.path;

        // Latest wrap event tells how many layers the cell started with (innermost layer first)
        let total = 0;
        let owners = [];
        for (const e of events.slice(0, step + 1)) {
            if (e.kind === "build") {
                total = 0;
                owners = [];
            }
            if (e.kind === "wrap") {
                total = e.layers.length;
                owners = e.layers.map(l => l.hop).reverse();
            }
        }

        const e = events[step];
        let layers = null;
        let peeled = false;
        if (e.kind === "wrap") {
            layers = total;
        } else if (e.kind === "peel" && path.includes(e.who)) {
            layers = total - (path.indexOf(e.who) + 1);
            peeled = true;
        } else if (e.kind === "drop" && path.includes(e.who)) {
            layers = total - path.indexOf(e.who);
        } else if (e.kind === "exit" || e.kind === "request" || e.kind === "ping") {
            layers = 0;
            peeled = (e.kind !== "request");
        } else if (e.kind === "response") {
            layers = total;
        }
        return { path: path, dead: now.dead, total: total, owners: owners, layers: layers, peeled: peeled };
    }

    function describe(events, step) {
        // One log event as a short plain-English sentence (relay names only, never addresses)
        const e = events[step];
        const who = e.who;
        const kind = e.kind;
        const before = circuitState(events, step - 1);
        const after = circuitState(events, step);
        const nextIndex = after.path.length;
        const nextName = nextIndex < after.chosen.length ? after.chosen[nextIndex] : "the next relay";

        if (kind === "build") return "Client picked " + e.names.join(", ") + " from the directory";
        if (kind === "hop_added") return "Circuit extended: client -> " + e.path.join(" -> ");
        if (kind === "circuit_ready") return "Circuit ready (" + e.buildMs.toFixed(0) + " ms to build)";
        if (kind === "wrap") return "Client wrapped " + e.cmd + " in " + e.layers.length + " encryption layer(s)";
        if (kind === "create") {
            if (before.path.length === 0) {
                return who + " did a key exchange with the client";
            }
            return who + " did a key exchange with the client, relayed through " + before.path[before.path.length - 1];
        }
        if (kind === "extend") return who + " was told to extend the circuit to " + nextName;
        if (kind === "linked") return who + " opened a link to " + nextName;
        if (kind === "peel") return who + " peeled its layer (" + e.inSize + " -> " + e.outSize + " bytes) and forwarded it";
        if (kind === "exit") return who + " (exit) sends '" + e.payload + "' to the destination";
        if (kind === "ping") return who + " (last hop) answered a heartbeat ping";
        if (kind === "drop") return who + " dropped a cell (packet loss)";
        if (kind === "error") return who + " rejected a cell: " + cleanText(e.detail);
        if (kind === "request") {
            const exitName = after.path.length ? after.path[after.path.length - 1] : "the exit relay";
            return "Destination got '" + e.payload + "' from " + exitName + " (the exit relay)";
        }
        if (kind === "response") return "Client received the reply in " + e.latencyMs.toFixed(0) + " ms";
        if (kind === "killed") return e.name + " CRASHED";
        if (kind === "request_failed") return "Request attempt " + e.attempt + " failed: " + cleanText(e.detail);
        if (kind === "rebuild_start") return "Client is rebuilding the circuit";
        if (kind === "dead_found") return "Client found dead relays: " + (e.dead.length ? e.dead.join(", ") : "none");
        if (kind === "build_failed") return "Circuit build failed: " + cleanText(e.detail);
        if (kind === "heartbeat_failed") return "Heartbeat failed, rebuilding";
        if (kind === "giving_up") return "Request failed (no more retries)";
        return kind;
    }

    // ---------- Shapes ----------
    function r2(v) {
        return Math.round(v * 100) / 100;
    }

    function addCircle(shapes, key, x, y, r, o) {
        // One circle. Same key in two steps = the same shape gliding.
        shapes.push({ t: "c", k: key, z: o.z !== undefined ? o.z : 4, x: r2(x), y: r2(y), r: r2(r), stroke: o.stroke || null,
                      fill: o.fill || null, sw: o.sw !== undefined ? o.sw : 2.6, op: o.op !== undefined ? o.op : 1.0,
                      fo: o.fo !== undefined ? o.fo : 1.0, dash: !!o.dash, glow: !!o.glow });
    }

    function addLabel(shapes, key, x, y, text, o) {
        // One text label (y is the baseline)
        shapes.push({ t: "t", k: key, z: o.z !== undefined ? o.z : 8, x: r2(x), y: r2(y), s: text, fill: o.fill || "#e8eaf2",
                      size: o.size || 0.27, weight: o.weight || "600", op: o.op !== undefined ? o.op : 1.0 });
    }

    function addLink(shapes, key, a, b, color, ra, rb, o) {
        /* A link with an arrowhead, stopping ra / rb short of each node. Dotted = in progress, solid = done.
           bend > 0 curves it upwards (fraction of its length) so it can arc over nodes in between. */
        const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (length <= ra + rb + 0.3) {
            return;
        }
        const ux = (b[0] - a[0]) / length;
        const uy = (b[1] - a[1]) / length;
        shapes.push({ t: "l", k: key, z: o.z !== undefined ? o.z : 2, x1: r2(a[0] + ux * ra), y1: r2(a[1] + uy * ra),
                      x2: r2(b[0] - ux * rb), y2: r2(b[1] - uy * rb), color: color, dotted: !!o.dotted,
                      sw: o.sw !== undefined ? o.sw : 2.2, op: o.op !== undefined ? o.op : 1.0,
                      bend: Math.round((o.bend || 0) * 1000) / 1000 });
    }

    function buildScene(run, step) {
        /* Everything on screen at `step` as a list of keyed shapes (step = -1: the scattered start).
           The player glides shapes with the same key from one step to the next. */
        const events = run.events;
        const e = step >= 0 ? events[step] : null;
        const kind = e ? e.kind : null;
        const who = e ? e.who : null;
        const state = circuitState(events, step);
        const onion = onionState(events, step);
        const path = state.path;
        const pending = state.pending;
        const dead = state.dead;
        const chosen = state.chosen;
        const positions = layoutAt(run, step);
        const shapes = [];

        // The source carries one ring per key it has wrapped with, newest outermost
        const rings = onion.total;
        const gap = ringStep(run);
        let srcOuter = rings === 0 ? 0.55 : 0.8 + gap * (rings - 1) + 0.08;
        const failing = FAIL_KINDS.includes(kind);
        if (failing) {
            srcOuter += 0.3;
        }

        function radiusOf(name) {
            return name === "client" ? srcOuter + 0.1 : 0.65;
        }

        function colorOf(name) {
            // A relay's hop colour once keyed (or while keying), white before that
            if (path.includes(name)) {
                return RING_COLORS[path.indexOf(name) % RING_COLORS.length];
            }
            if (name === pending) {
                return RING_COLORS[path.length % RING_COLORS.length];
            }
            return WHITE;
        }

        // Background: faint rings around the centre, like the cut face of an onion
        for (const radius of [2.5, 5.0, 7.5, 10.0]) {
            addCircle(shapes, "bg" + radius, 8, 4.6, radius, { stroke: WHITE, sw: 1, op: 0.05, z: 0 });
        }

        // The key each relay shares with the source: an arc from the source (dotted while agreed, solid once agreed).
        // Hop 1 is a straight line, later hops arc over the ones before.
        function keyArc(name, hopIndex, dotted, color, key) {
            const chord = Math.hypot(positions[name][0] - positions.client[0], positions[name][1] - positions.client[1]);
            const peak = hopIndex === 0 ? 0 : 1.1 + 0.7 * (hopIndex - 1);
            addLink(shapes, key || "K:" + name, positions.client, positions[name], color || RING_COLORS[hopIndex % RING_COLORS.length],
                    radiusOf("client"), 0.65, { dotted: dotted, bend: 2 * peak / Math.max(chord, 0.1), z: key ? 3 : 2 });
        }

        for (let i = 0; i < path.length; i++) {
            keyArc(path[i], i, false);
            if (i > 0) {
                // The real connection between two relays: a thin white line
                addLink(shapes, "P:" + path[i - 1] + ">" + path[i], positions[path[i - 1]], positions[path[i]], WHITE, 0.65, 0.65, { sw: 1.8, op: 0.6 });
            }
        }
        if (state.ready && path.length > 0) {
            const last = path[path.length - 1];
            addLink(shapes, "L:" + last + ">destination", positions[last], positions.destination, DEST_GREEN, 0.65, 0.65, {});
        }

        // Key exchange in progress: dotted arc from the source in the colour the new relay is about to get
        if (pending !== null) {
            keyArc(pending, path.length, true);
            if (path.length > 0) {
                const bright = (kind === "linked");
                const last = path[path.length - 1];
                addLink(shapes, "P:" + last + ">" + pending, positions[last], positions[pending], WHITE, 0.65, 0.65,
                        { sw: bright ? 2.4 : 1.8, op: bright ? 1.0 : 0.6, z: bright ? 3 : 2 });
            }
        }

        // "Told to extend": a bright white line from the last relay to the one it must reach
        if (kind === "extend" && chosen.length > path.length && pending === null) {
            const target = chosen[path.length];
            addLink(shapes, "P:" + who + ">" + target, positions[who], positions[target], WHITE, 0.65, 0.65, { sw: 2.4, z: 3 });
        }

        // The exit hands a plain message to the destination
        if (kind === "exit") {
            addLink(shapes, "exitlink", positions[who], positions.destination, PLAIN, 0.65, 0.65, { dotted: true, z: 3 });
        }

        // Failures: red dotted arrows
        if ((kind === "drop" || kind === "error") && path.includes(who)) {
            const index = path.indexOf(who);
            const origin = index > 0 ? path[index - 1] : "client";
            addLink(shapes, "faillink", positions[origin], positions[who], ALERT, radiusOf(origin), 0.65, { dotted: true, z: 3 });
        }
        if (kind === "rebuild_start") {
            for (let i = 0; i < path.length; i++) {
                keyArc(path[i], i, true, ALERT, "red" + i);
            }
        }

        // Nodes
        for (const name in positions) {
            const x = positions[name][0];
            const y = positions[name][1];
            if (name === "client") {
                for (let i = 0; i < rings; i++) {
                    const newest = (kind === "wrap" && i === rings - 1);
                    addCircle(shapes, "src" + i, x, y, 0.8 + gap * i, { stroke: RING_COLORS[i % RING_COLORS.length], sw: newest ? 3 : 2.6, glow: true, z: 4 });
                }
                if (failing) {
                    addCircle(shapes, "failring", x, y, srcOuter, { stroke: ALERT, sw: 3, glow: true, z: 4 });
                }
                if (kind === "wrap") {
                    addCircle(shapes, "wrapring", x, y, srcOuter + 0.2, { stroke: WHITE, sw: 1.2, op: 0.7, dash: true, z: 3 });
                }
                addCircle(shapes, "n:client", x, y, 0.55, { stroke: WHITE, fill: WHITE, sw: 2, z: 5 });
                addLabel(shapes, "lbl:client", x, y - srcOuter - 0.35 - 0.25, "You (source)", { weight: "700" });
            } else if (name === "destination") {
                addCircle(shapes, "n:destination", x, y, 0.55, { stroke: DEST_GREEN, fill: DEST_GREEN, sw: 2, z: 5 });
                addLabel(shapes, "lbl:destination", x, y - 1.0 - 0.25, "Destination", { weight: "700" });
            } else {
                let color = colorOf(name);
                const keyed = path.includes(name);
                let alpha = 1.0;
                if (chosen.length > 0 && !chosen.includes(name)) {
                    alpha = dead.includes(name) ? 0.5 : 0.12;        // relays nobody picked fade right back
                }
                if (keyed || name === pending) {
                    addCircle(shapes, "h1:" + name, x, y, 0.85, { stroke: color, sw: 1.5, op: 0.4, z: 3 });
                    addCircle(shapes, "h2:" + name, x, y, 1.1, { stroke: color, sw: 1.0, op: 0.18, z: 3 });
                }
                if (dead.includes(name)) {
                    color = ALERT;
                }
                addCircle(shapes, "n:" + name, x, y, 0.55, { stroke: color, fill: DARK_BG, sw: 2.6, op: alpha, z: 4 });
                if (dead.includes(name)) {
                    addLabel(shapes, "x:" + name, x, y - 0.17, "✕", { fill: ALERT, size: 0.5, weight: "700", z: 9 });
                }
                addLabel(shapes, "lbl:" + name, x, y - 1.2 - 0.25, name, { weight: "700", op: alpha });
                if (keyed) {
                    const hop = path.indexOf(name) + 1;
                    addLabel(shapes, "sub:" + name, x, y - 1.7 - 0.2, "hop " + hop + "  ·  key K" + hop, { fill: MUTED, size: 0.2, weight: "400" });
                } else if (name === pending) {
                    addLabel(shapes, "sub:" + name, x, y - 1.7 - 0.2, "key exchange...", { fill: MUTED, size: 0.2, weight: "400" });
                }
            }
        }

        // What is happening right now: halo, onion packet and a short tag
        if (e !== null) {
            let target = kind === "killed" ? e.name : who;
            if (kind === "hop_added" && path.length > 0) {
                target = path[path.length - 1];
            }
            let halo = null;
            let tag = "";
            let tagColor = PLAIN;
            if (kind === "build") {
                halo = WHITE; tag = "RELAYS PICKED";
            } else if (kind === "create") {
                halo = colorOf(who); tag = "KEY EXCHANGE";
            } else if (kind === "linked") {
                halo = colorOf(who); tag = "LINK OPENED";
            } else if (kind === "extend") {
                halo = WHITE; tag = "EXTEND ORDER";
            } else if (kind === "hop_added") {
                halo = colorOf(target); tag = "CIRCUIT EXTENDED";
            } else if (kind === "circuit_ready") {
                halo = DEST_GREEN; tag = "CIRCUIT READY";
            } else if (kind === "wrap") {
                tag = "WRAPPED IN " + plural(onion.total, "LAYER");
            } else if (kind === "response") {
                halo = DEST_GREEN; tag = "REPLY RECEIVED"; tagColor = DEST_GREEN;
            } else if (kind === "killed" || kind === "dead_found" || kind === "drop" || kind === "error") {
                halo = ALERT;
                tag = { killed: "CRASHED", dead_found: "DEAD RELAYS", drop: "CELL LOST", error: "REJECTED" }[kind];
                tagColor = ALERT;
            } else if (FAIL_KINDS.includes(kind) || kind === "rebuild_start") {
                tag = { request_failed: "REQUEST FAILED", build_failed: "BUILD FAILED", heartbeat_failed: "HEARTBEAT FAILED",
                        giving_up: "GIVING UP", rebuild_start: "REBUILDING" }[kind];
                tagColor = ALERT;
            }

            // Dead relays found: ring all of them
            if (kind === "dead_found") {
                for (const name of dead) {
                    if (positions[name] !== undefined) {
                        addCircle(shapes, "deadring:" + name, positions[name][0], positions[name][1], 1.0, { stroke: ALERT, sw: 2.5, op: 0.8, z: 5, glow: true });
                    }
                }
            }

            if (positions[target] !== undefined) {
                const x = positions[target][0];
                const y = positions[target][1];
                // Baseline of the tag: just under the node's own labels
                let tagY = y - 1.9 - 0.5;
                if (target === "client") {
                    tagY = y - srcOuter - 0.6 - 0.5;
                } else if (target === "destination") {
                    tagY = y - 1.25 - 0.5;
                }
                const layers = onion.layers;
                if (layers !== null && (kind === "peel" || kind === "exit" || kind === "request" || kind === "ping")) {
                    // The onion packet itself, one ring per layer it still carries (outer ring = next relay to peel)
                    const total = onion.total;
                    addCircle(shapes, "pkunder", x, y, 0.65 + gap * Math.max(layers, 1) + 0.12, { fill: DARK_BG, sw: 0, z: 5 });
                    for (let j = 0; j < layers; j++) {
                        const hop = total - layers + j;
                        const c = RING_COLORS[hop % RING_COLORS.length];
                        addCircle(shapes, "pk" + hop, x, y, 0.65 + gap * (layers - j), { stroke: c, fill: c, sw: 2.2, fo: 0.3, glow: true, z: 6 });
                    }
                    addCircle(shapes, "pkcore", x, y, 0.26, { fill: layers > 0 ? WHITE : PLAIN, sw: 0, z: 7 });
                    if (layers === 0) {
                        addCircle(shapes, "pkplain", x, y, 0.5, { stroke: PLAIN, sw: 1.5, dash: true, z: 7 });
                    }
                    if (kind === "peel") {
                        const ring = RING_COLORS[(total - layers - 1) % RING_COLORS.length];
                        addCircle(shapes, "peelring", x, y, 0.85 + gap * (layers + 1), { stroke: ring, sw: 1.6, op: 0.7, dash: true, z: 5 });
                        tag = layers > 0 ? plural(layers, "LAYER") + " LEFT" : "LAST LAYER OFF";
                    } else if (kind === "exit") {
                        tag = "PLAIN MESSAGE";
                    } else if (kind === "request") {
                        tag = "DESTINATION READS IT";
                    } else {
                        tag = "PONG";
                    }
                } else if (halo !== null) {
                    addCircle(shapes, "halo", x, y, target === "client" ? srcOuter + 0.25 : 1.0, { stroke: halo, sw: 2.5, op: 0.85, z: 5, glow: true });
                }
                if (kind === "drop") {
                    addLabel(shapes, "dropx", x, y - 0.17, "✕", { fill: ALERT, size: 0.5, weight: "700", z: 9 });
                }
                if (tag !== "") {
                    addLabel(shapes, "tag", x, tagY, tag, { fill: tagColor, size: 0.25, weight: "700" });
                }
            }
        }
        return shapes;
    }

    function sectionData(onion) {
        // The onion cross-section at this step: one entry per ring, outermost first
        const total = onion.total;
        const layers = onion.layers !== null ? onion.layers : total;      // between packet events: last known state
        const rings = [];
        for (let j = 0; j < total; j++) {
            const owner = j < onion.owners.length ? onion.owners[j] : "K" + (j + 1);
            rings.push({ c: RING_COLORS[j % RING_COLORS.length], peeled: j < total - layers, owner: owner });
        }
        return { rings: rings, plain: layers === 0 && total > 0 };
    }

    function buildPlayerData(rawEvents, relayNames, hops) {
        /* Input  : the run's events (t in ms from the start), the relay pool, the circuit length
           Output : everything the player needs, every step precomputed so playing never waits */
        const events = slimEvents(rawEvents);
        const run = { events: events, relayNames: relayNames, hops: hops };
        const steps = [];
        for (let i = 0; i < events.length; i++) {
            steps.push({ prims: buildScene(run, i), kind: events[i].kind, text: describe(events, i), why: WHY[events[i].kind] || "",
                         who: whoLabel(events[i].who), t: Math.round(events[i].t), sec: sectionData(onionState(events, i)) });
        }
        return { steps: steps, intro: buildScene(run, -1) };
    }

    return { buildPlayerData, buildScene, layoutAt, circuitState, onionState, describe, whoLabel, slimEvents, WHY };
})();

if (typeof module !== "undefined") {
    module.exports = Scene;
}
