# Onion Routing Network (Team 23)

A small Tor-style onion routing overlay for the Distributed Systems course. A client reaches a destination through N relays, so that no single relay knows both who is asking and what is being asked. It is a teaching prototype, not a deployable anonymity tool.

**Live dashboard (GitHub Pages):** https://avi1o1.github.io/onion-routing-network/

## Features

- Directory service: relays register their address and public key, clients fetch the list
- Circuits built one hop at a time (X25519 ephemeral key exchange + relay long-term key, HKDF, forward secrecy)
- One AES-GCM layer per hop, fixed-size 1024 byte cells
- Failure handling: dead relay detection, circuit rebuild, explicit in-flight policy (retry once, or fail with a clear error), optional heartbeat
- Per-hop observation logs + a checker for the anonymity claims
- Latency comparison for 1 to 5 hops
- Streamlit dashboard to tweak hops, delay, packet loss and crashes and watch the effect
- Animated step-by-step player: relays drift into a circuit, keys appear as rings around the source, the onion packet loses a layer at every hop; full event log with the current step highlighted

## Files

| File | What it does |
|---|---|
| `src/onion.py` | keys, onion layers, cell framing, logging |
| `src/directory.py` | directory service |
| `src/relay.py` | relay |
| `src/destination.py` | destination service |
| `src/client.py` | circuit building, requests, failure policy, heartbeat |
| `src/experiment.py` | starts a whole network inside one process, runs requests, latency sweep |
| `src/analysis.py` | "what did each hop see" + anonymity claim checks |
| `src/dashboard.py` | Streamlit dashboard |
| `src/player.html` | Streamlit wrapper that inlines the shared player from `site/` |
| `tests/test_onion.py` | pytest tests |
| `site/sim.js` | JS port of the protocol for the browser version (real WebCrypto, simulated network) |
| `site/scene.js`, `site/player.js`, `site/player.css` | the step-by-step player, shared by the Pages site and the Streamlit dashboard |
| `site/index.html`, `site/app.js`, `site/style.css` | the Pages version of the dashboard (a settings rail and one scrolling page) |

## How to use

1. Install: `python3 -m venv .venv && .venv/bin/pip install -r requirements.txt`
2. Dashboard (easiest): `.venv/bin/streamlit run src/dashboard.py`
3. Tests: `.venv/bin/pytest tests`
4. Latency plot from the command line: `.venv/bin/python src/experiment.py` (writes `latency.png`)
5. Separate processes over real TCP ports (from the project folder, one terminal each):
   ```
   mkdir -p logs
   .venv/bin/python src/directory.py 9000
   .venv/bin/python src/destination.py 9100
   .venv/bin/python src/relay.py R1 9001 9000
   .venv/bin/python src/relay.py R2 9002 9000
   .venv/bin/python src/relay.py R3 9003 9000
   .venv/bin/python src/client.py 9000 9100 3
   ```
   Every component writes what it observed to `logs/<name>.jsonl`. Kill a relay (Ctrl+C) between client runs, or while it is running, to see the circuit rebuild.

The Pages dashboard cannot open TCP sockets, so `site/sim.js` re-implements the protocol in the browser: real WebCrypto ECDH, HKDF and AES-GCM layers, but the network (delay, loss, crashes) is simulated with a virtual clock. The Streamlit dashboard runs the actual Python relays. Both feed their event log to the same player (`site/scene.js` + `site/player.js`), so they draw the same picture.

## How it works (short version)

1. Client asks the directory for relays and picks N of them.
2. It sends CREATE to the entry relay. For every next hop it sends an `EXTEND` command wrapped in the layers built so far; the last relay in the circuit opens a TCP link to the new relay and passes the client's fresh public key on.
3. A request is wrapped once per hop. Each relay peels exactly one layer, forwards the rest and later adds one layer to the reply on the way back.
4. Failure: any timeout / closed link / bad tag means the circuit is broken. The client probes the relays of that circuit, removes dead ones from the directory and builds a new circuit. In-flight request policy: retry once on the new circuit, otherwise return a clear error.

## Known simplifications

- Relays handle one cell at a time per circuit (lock-step request/reply), no multiplexing or flow control.
- A request and reply must fit in one cell (about 900 bytes at 5 hops).
- The cell header leaks the ciphertext length on each link (so cell size is only mostly hidden).
- The exit relay sees the plaintext request (no end-to-end TLS to the destination).
- No defence against traffic correlation by a colluding entry and exit, nor against a compromised directory.
- Everything runs on localhost, so "latency" is simulated with the per-link delay slider.

## Technologies used

Python 3 asyncio, `cryptography` (X25519, HKDF, AES-GCM), Streamlit, pandas, matplotlib, pytest. Vanilla JS + SVG for the player and the Pages site.
