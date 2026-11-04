// Browser port of the onion routing demo (same protocol as src/*.py).
// Real crypto (WebCrypto ECDH + HKDF + AES-GCM, one layer per hop), but the network is simulated
// with a virtual clock: link delay, packet loss and crashes are just numbers we add or throw.

const Sim = (() => {
    // ---------- Constants ----------
    const EXTEND = 1, EXTENDED = 2, REQUEST = 3, RESPONSE = 4, PING = 5, PONG = 6, ERROR = 7;
    const CMD_NAMES = { 1: "EXTEND", 2: "EXTENDED", 3: "REQUEST", 4: "RESPONSE", 5: "PING", 6: "PONG", 7: "ERROR" };
    const CELL_SIZE = 1024;
    const CRYPTO_MS = 0.15;     // pretend cost of one layer operation
    const HEARTBEAT_MS = 100;
    const subtle = crypto.subtle;
    const enc = new TextEncoder();
    const dec = new TextDecoder();

    const DEFAULT_CONFIG = {
        hops: 3, relays: 6, delayMs: 10, lossPct: 0, requests: 6, timeoutMs: 500,
        killAt: null, killHop: 1, retry: true, heartbeat: false,
    };

    // ---------- Crypto helpers ----------
    function hex8(bytes) {
        // First 8 bytes as hex
        return Array.from(bytes.slice(0, 8)).map(b => b.toString(16).padStart(2, "0")).join("");
    }

    function concat(a, b) {
        const out = new Uint8Array(a.length + b.length);
        out.set(a);
        out.set(b, a.length);
        return out;
    }

    async function newPair() {
        return subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    }

    async function pubBytes(pair) {
        return new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
    }

    async function dh(privKey, pubRaw) {
        const pub = await subtle.importKey("raw", pubRaw, { name: "ECDH", namedCurve: "P-256" }, false, []);
        return new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: pub }, privKey, 256));
    }

    async function deriveKeys(dh1, dh2) {
        // HKDF the two DH outputs into a forward and a backward AES-GCM key
        const base = await subtle.importKey("raw", concat(dh1, dh2), "HKDF", false, ["deriveBits"]);
        const params = { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: enc.encode("onion-demo") };
        const bits = new Uint8Array(await subtle.deriveBits(params, base, 512));
        const fwd = await subtle.importKey("raw", bits.slice(0, 32), "AES-GCM", false, ["encrypt", "decrypt"]);
        const bwd = await subtle.importKey("raw", bits.slice(32), "AES-GCM", false, ["encrypt", "decrypt"]);
        return { fwd: fwd, bwd: bwd, fc: 0, bc: 0 };
    }

    function makeNonce(counter) {
        const nonce = new Uint8Array(12);
        new DataView(nonce.buffer).setUint32(8, counter);
        return nonce;
    }

    async function seal(key, counter, data) {
        return new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: makeNonce(counter) }, key, data));
    }

    async function open(key, counter, data) {
        return new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: makeNonce(counter) }, key, data));
    }

    // ---------- World ----------
    function log(w, who, kind, extra) {
        w.events.push(Object.assign({ t: w.T, who: who, kind: kind }, extra || {}));
    }

    function linkDelay(w) {
        // One link crossing, with a little jitter
        return w.cfg.delayMs * (0.9 + 0.2 * Math.random());
    }

    function randomPort() {
        return 40000 + Math.floor(Math.random() * 20000);
    }

    async function makeWorld(config) {
        const cfg = Object.assign({}, DEFAULT_CONFIG, config);
        const w = { cfg: cfg, T: 0, events: [], relays: [], directory: [], circuit: null,
                    clientAddr: "127.0.0.1:" + randomPort(), destAddr: "127.0.0.1:9100" };
        for (let i = 0; i < cfg.relays; i++) {
            const pair = await newPair();
            const relay = { name: "R" + (i + 1), alive: true, pair: pair, pub: await pubBytes(pair), port: 9001 + i };
            w.relays.push(relay);
            w.directory.push(relay);
        }
        return w;
    }

    function circuitError(kind) {
        // Readable errors, same wording as the Python client
        if (kind === "closed") return "Circuit broken: a relay on the path closed the connection";
        if (kind === "timeout") return "Timed out waiting for a reply (relay dead or cell lost)";
        return kind;
    }

    // ---------- Sending one cell through the circuit ----------
    async function sendThrough(w, cmd, data, circuit) {
        /* Wrap for the last hop, push it hop by hop (each relay peels one layer),
           then the reply comes back with one layer added per hop. */
        const hops = circuit.hops;
        const last = hops.length - 1;
        const sendT = w.T;

        // Step 1 : wrap, innermost layer is for the last hop
        let cell = concat(new Uint8Array([cmd]), data);
        const layers = [];
        for (let i = last; i >= 0; i--) {
            cell = await seal(hops[i].c.fwd, hops[i].c.fc++, cell);
            layers.push({ hop: hops[i].relay.name, size: cell.length, prefix: hex8(cell) });
        }
        w.T += CRYPTO_MS * hops.length;
        log(w, "client", "wrap", { cmd: CMD_NAMES[cmd], layers: layers });

        // Step 2 : forward trip
        for (let i = 0; i <= last; i++) {
            const hop = hops[i];
            const relay = hop.relay;
            if (!relay.alive) {
                throw { kind: "closed" };
            }
            w.T += linkDelay(w);
            if (Math.random() * 100 < w.cfg.lossPct) {
                log(w, relay.name, "drop", { prev: hop.prevAddr });
                w.T = sendT + w.cfg.timeoutMs;
                throw { kind: "timeout" };
            }
            const received = cell;
            cell = await open(hop.r.fwd, hop.r.fc++, cell);
            if (i < last) {
                log(w, relay.name, "peel", { role: "forward", prev: hop.prevAddr, next: hops[i + 1].relay.name,
                                             inPrefix: hex8(received), outPrefix: hex8(cell),
                                             inSize: received.length, outSize: cell.length });
            }
        }

        // Step 3 : the last hop handles the command
        const lastHop = hops[last];
        const relay = lastHop.relay;
        const body = cell.slice(1);
        let replyCmd = ERROR;
        let replyData = enc.encode("unknown command");

        if (cell[0] === EXTEND) {
            const target = JSON.parse(dec.decode(body));
            log(w, relay.name, "extend", { prev: lastHop.prevAddr, next: target.name });
            const targetRelay = w.relays.find(r => r.name === target.name);
            if (targetRelay.alive) {
                log(w, relay.name, "linked", { localAddr: target.prevAddr, next: target.name });
                log(w, target.name, "create", { prev: target.prevAddr });
                replyCmd = EXTENDED;
                replyData = new Uint8Array(0);
            } else {
                replyData = enc.encode("could not reach next relay");
            }
        } else if (cell[0] === REQUEST) {
            const req = JSON.parse(dec.decode(body));
            const exitAddr = "127.0.0.1:" + randomPort();
            log(w, relay.name, "exit", { prev: lastHop.prevAddr, dest: req.dest, payload: req.payload });
            log(w, "destination", "request", { prev: exitAddr, payload: req.payload });
            replyCmd = RESPONSE;
            replyData = enc.encode("Hello from destination! You said: " + req.payload);
        } else if (cell[0] === PING) {
            log(w, relay.name, "ping", { prev: lastHop.prevAddr });
            replyCmd = PONG;
            replyData = new Uint8Array(0);
        }

        // Step 4 : reply trip, every relay adds its layer, the entry relay is outermost
        let reply = concat(new Uint8Array([replyCmd]), replyData);
        for (let i = last; i >= 0; i--) {
            w.T += linkDelay(w);
            reply = await seal(hops[i].r.bwd, hops[i].r.bc++, reply);
        }
        for (let i = 0; i <= last; i++) {
            reply = await open(hops[i].c.bwd, hops[i].c.bc++, reply);
        }
        w.T += CRYPTO_MS * hops.length;
        return { cmd: reply[0], data: reply.slice(1) };
    }

    // ---------- Circuit building and recovery ----------
    async function handshake(relay) {
        /* Ephemeral key exchange mixed with the relay's long-term key (from the directory).
           Returns the client's view (c) and the relay's view (r) of the session keys. */
        const cEph = await newPair();
        const rEph = await newPair();
        const cPub = await pubBytes(cEph);
        const rPub = await pubBytes(rEph);
        const c = await deriveKeys(await dh(cEph.privateKey, rPub), await dh(cEph.privateKey, relay.pub));
        const r = await deriveKeys(await dh(rEph.privateKey, cPub), await dh(relay.pair.privateKey, cPub));
        return { c: c, r: r };
    }

    async function buildCircuit(w) {
        const start = w.T;
        w.circuit = null;

        // Step 1 : ask the directory and pick random relays
        if (w.directory.length < w.cfg.hops) {
            throw { kind: "Not enough relays: need " + w.cfg.hops + ", directory has " + w.directory.length };
        }
        const pool = w.directory.slice().sort(() => Math.random() - 0.5);
        const chosen = pool.slice(0, w.cfg.hops);
        log(w, "client", "build", { path: [], names: chosen.map(r => r.name) });
        const circuit = { hops: [] };
        w.circuit = circuit;

        // Step 2 : extend one hop at a time
        for (let i = 0; i < chosen.length; i++) {
            const relay = chosen[i];
            const keys = await handshake(relay);
            const prevAddr = (i === 0) ? w.clientAddr : "127.0.0.1:" + randomPort();

            if (i === 0) {
                if (!relay.alive) {
                    throw { kind: "closed" };
                }
                w.T += 0.5;
                log(w, relay.name, "create", { prev: w.clientAddr });
            } else {
                const target = { name: relay.name, prevAddr: prevAddr };
                const reply = await sendThrough(w, EXTEND, enc.encode(JSON.stringify(target)), circuit);
                if (reply.cmd !== EXTENDED) {
                    throw { kind: "Extend failed: " + dec.decode(reply.data) };
                }
            }
            circuit.hops.push({ relay: relay, c: keys.c, r: keys.r, prevAddr: prevAddr });
            log(w, "client", "hop_added", { path: circuit.hops.map(h => h.relay.name), clientAddr: w.clientAddr });
        }

        const buildMs = w.T - start;
        log(w, "client", "circuit_ready", { path: circuit.hops.map(h => h.relay.name), buildMs: buildMs });
        return buildMs;
    }

    function findDeadRelays(w) {
        // Probe the relays of the broken circuit, remove dead ones from the directory
        const dead = [];
        if (w.circuit !== null) {
            for (const hop of w.circuit.hops) {
                if (!hop.relay.alive) {
                    dead.push(hop.relay.name);
                    w.directory = w.directory.filter(r => r !== hop.relay);
                }
            }
        }
        log(w, "client", "dead_found", { dead: dead });
        return dead;
    }

    async function rebuildCircuit(w) {
        log(w, "client", "rebuild_start");
        findDeadRelays(w);
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                await buildCircuit(w);
                return true;
            } catch (err) {
                log(w, "client", "build_failed", { detail: circuitError(err.kind) });
                findDeadRelays(w);
            }
        }
        return false;
    }

    async function request(w, payload) {
        /* Policy for in-flight requests: if the circuit breaks, rebuild and retry ONCE
           (retry = true), otherwise fail with a clear error. */
        const start = w.T;
        const maxAttempts = w.cfg.retry ? 2 : 1;
        let attempts = 0;
        let rebuilt = false;
        let error = "";

        while (attempts < maxAttempts) {
            attempts++;
            try {
                if (w.circuit === null || w.circuit.hops.length < w.cfg.hops) {
                    await buildCircuit(w);
                }
                const body = enc.encode(JSON.stringify({ dest: w.destAddr, payload: payload }));
                const reply = await sendThrough(w, REQUEST, body, w.circuit);
                if (reply.cmd !== RESPONSE) {
                    throw { kind: dec.decode(reply.data) };
                }
                const latency = w.T - start;
                log(w, "client", "response", { text: dec.decode(reply.data), latencyMs: latency });
                return { ok: true, response: dec.decode(reply.data), error: "", latencyMs: latency,
                         attempts: attempts, rebuilt: rebuilt };
            } catch (err) {
                error = circuitError(err.kind || String(err));
                log(w, "client", "request_failed", { attempt: attempts, detail: error });
                rebuilt = await rebuildCircuit(w);
            }
        }
        log(w, "client", "giving_up", { detail: error });
        return { ok: false, response: "", error: error, latencyMs: w.T - start, attempts: attempts, rebuilt: rebuilt };
    }

    async function runExperiment(config) {
        const w = await makeWorld(config);
        const cfg = w.cfg;
        const results = [];

        for (let i = 0; i < cfg.requests; i++) {
            // Crash a relay of the current circuit just before this request
            if (cfg.killAt === i && w.circuit !== null) {
                const victim = w.circuit.hops[Math.min(cfg.killHop, w.circuit.hops.length - 1)].relay;
                victim.alive = false;
                log(w, "experiment", "killed", { name: victim.name });

                // Heartbeat notices the dead relay and rebuilds before the next request
                if (cfg.heartbeat) {
                    w.T += HEARTBEAT_MS;
                    try {
                        await sendThrough(w, PING, new Uint8Array(0), w.circuit);
                    } catch (err) {
                        log(w, "client", "heartbeat_failed");
                        await rebuildCircuit(w);
                    }
                    w.T += HEARTBEAT_MS * 3;
                }
            }
            const result = await request(w, "message " + i);
            result.index = i;
            results.push(result);
        }

        const ready = w.events.find(e => e.kind === "circuit_ready");
        return { results: results, events: w.events, relayNames: w.relays.map(r => r.name), destAddr: w.destAddr,
                 buildMs: ready ? ready.buildMs : null, config: cfg, clientAddr: w.clientAddr };
    }

    async function sweepHops(config, hopsList, reps) {
        // Same experiment for several path lengths, no crashes
        const rows = [];
        for (const hops of hopsList) {
            for (let rep = 0; rep < reps; rep++) {
                const cfg = Object.assign({}, config, { hops: hops, relays: Math.max(config.relays, hops), killAt: null });
                const run = await runExperiment(cfg);
                for (const r of run.results) {
                    if (r.ok) {
                        rows.push({ hops: hops, latencyMs: r.latencyMs, buildMs: run.buildMs });
                    }
                }
            }
        }
        return rows;
    }

    // ---------- Anonymity analysis (port of analysis.py) ----------
    function whatEachHopSaw(events, path, clientAddr) {
        const rows = [];
        for (let p = 0; p < path.length; p++) {
            const row = { relay: path[p], position: p + 1, knowsClient: false, knowsNextHop: false,
                          knowsDestination: false, seesPlaintext: false };
            for (const e of events) {
                if (e.who !== path[p]) {
                    continue;
                }
                if (e.kind === "create" && e.prev === clientAddr) {
                    row.knowsClient = true;
                }
                if (e.kind === "extend" || e.kind === "linked") {
                    row.knowsNextHop = true;
                }
                if (e.kind === "exit") {
                    row.knowsDestination = true;
                    row.seesPlaintext = true;
                }
            }
            rows.push(row);
        }
        return rows;
    }

    function checkClaims(rows) {
        const entry = rows[0];
        const exitRelay = rows[rows.length - 1];
        let linked = false;
        for (const row of rows) {
            if (row.knowsClient && row.knowsDestination) {
                linked = true;
            }
        }
        let middleClean = true;
        for (const row of rows.slice(1, -1)) {
            if (row.knowsClient || row.knowsDestination || row.seesPlaintext) {
                middleClean = false;
            }
        }
        return [
            ["No single relay knows both the client and the destination", !linked],
            ["Entry relay does not see the destination or the payload", !entry.knowsDestination],
            ["Exit relay does not know the client's address", !exitRelay.knowsClient],
            ["Middle relays know neither the client nor the destination", middleClean],
        ];
    }

    return { DEFAULT_CONFIG, CELL_SIZE, runExperiment, sweepHops, whatEachHopSaw, checkClaims };
})();

if (typeof module !== "undefined") {
    module.exports = Sim;
}
