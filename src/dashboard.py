# Interactive dashboard: tweak the network, run real relays/client, watch what happens.
# Run with:  streamlit run src/dashboard.py

# Importing Modules
import re
import json
import asyncio
from pathlib import Path

import streamlit as st
import pandas as pd
import matplotlib
import matplotlib.pyplot as plt

import experiment
import analysis

# Defining Constants
BLUE = "#2a6fdb"        # charts: request latency
RED = "#d6453d"         # charts: failures / build time
GREEN = "#2f9e5b"       # charts: success
SITE_DIR = Path(__file__).resolve().parent.parent / "site"     # the player is shared with the Pages site
PLAYER_TEMPLATE = Path(__file__).with_name("player.html")
PLAYER_HEIGHT = 1030
MAX_EASY_STEPS = 30     # above this many log events a run gets hard to follow
PLAYER_FIELDS = ("kind", "who", "names", "path", "cmd", "inSize", "outSize", "payload",
                 "name", "attempt", "detail", "dead", "buildMs", "latencyMs")     # all the player reads (no addresses)


# Defining Functions
def circuitState(events, step):
    """
    Replay the log up to `step`: relays picked, hops with an agreed key (path), the hop whose
    key exchange is still going on (pending), crashed relays and whether the circuit is ready.
    """
    state = {"chosen": [], "path": [], "pending": None, "dead": [], "ready": False}
    for e in events[:step + 1]:
        kind = e["kind"]
        if kind == "build":
            state["chosen"] = e["names"]
            state["path"] = []
            state["pending"] = None
            state["ready"] = False
        elif kind == "create":
            state["pending"] = e["who"]
        elif kind == "hop_added":
            state["path"] = e["path"]
            state["pending"] = None
        elif kind == "circuit_ready":
            state["ready"] = True
        elif kind == "killed":
            state["dead"].append(e["name"])
    return state


def cleanText(text):
    """
    Helper function: no IPs or ports in anything the user reads, relays are only ever R1, R2, ...
    """
    return re.sub(r"127\.0\.0\.1:\d+", "a relay", str(text))


def describe(events, step):
    """
    Turn one log event into a short plain-English sentence (relay names only, never addresses).
    """
    e = events[step]
    who = e["who"]
    kind = e["kind"]
    before = circuitState(events, step - 1)
    after = circuitState(events, step)
    nextIndex = len(after["path"])
    nextName = after["chosen"][nextIndex] if nextIndex < len(after["chosen"]) else "the next relay"

    if kind == "build":
        return f"Client picked {', '.join(e['names'])} from the directory"
    if kind == "hop_added":
        return f"Circuit extended: client -> {' -> '.join(e['path'])}"
    if kind == "circuit_ready":
        return f"Circuit ready ({e['buildMs']:.0f} ms to build)"
    if kind == "wrap":
        return f"Client wrapped {e['cmd']} in {len(e['layers'])} encryption layer(s)"
    if kind == "create":
        if len(before["path"]) == 0:
            return f"{who} did a key exchange with the client"
        return f"{who} did a key exchange with the client, relayed through {before['path'][-1]}"
    if kind == "extend":
        return f"{who} was told to extend the circuit to {nextName}"
    if kind == "linked":
        return f"{who} opened a link to {nextName}"
    if kind == "peel":
        return f"{who} peeled its layer ({e['inSize']} -> {e['outSize']} bytes) and forwarded it"
    if kind == "exit":
        return f"{who} (exit) sends '{e['payload']}' to the destination"
    if kind == "ping":
        return f"{who} (last hop) answered a heartbeat ping"
    if kind == "drop":
        return f"{who} dropped a cell (packet loss)"
    if kind == "error":
        return f"{who} rejected a cell: {cleanText(e['detail'])}"
    if kind == "request":
        exitName = after["path"][-1] if after["path"] else "the exit relay"
        return f"Destination got '{e['payload']}' from {exitName} (the exit relay)"
    if kind == "response":
        return f"Client received the reply in {e['latencyMs']:.0f} ms"
    if kind == "killed":
        return f"{e['name']} CRASHED"
    if kind == "request_failed":
        return f"Request attempt {e['attempt']} failed: {cleanText(e['detail'])}"
    if kind == "rebuild_start":
        return "Client is rebuilding the circuit"
    if kind == "dead_found":
        return f"Client found dead relays: {', '.join(e['dead']) if e['dead'] else 'none'}"
    if kind == "build_failed":
        return f"Circuit build failed: {cleanText(e['detail'])}"
    if kind == "heartbeat_failed":
        return "Heartbeat failed, rebuilding"
    if kind == "giving_up":
        return "Request failed (no more retries)"
    return kind


def playerEvents(run):
    """
    Input  : one finished run
    Output : its events with only the fields the player reads (no IPs or ports), t in ms from the start
    """
    events = run["events"]
    start = events[0]["t"]
    slim = []
    for e in events:
        item = {"t": round((e["t"] - start) * 1000, 1)}
        for field in PLAYER_FIELDS:
            if field in e:
                item[field] = e[field]
        if "layers" in e:
            item["layers"] = [{"hop": layer["hop"]} for layer in e["layers"]]
        if "detail" in item:
            item["detail"] = cleanText(item["detail"])
        slim.append(item)
    return slim


def buildPlayerHtml(run):
    """
    Input  : one finished run
    Output : a self-contained page with the shared player (site/scene.js + site/player.js) and this run's events.
             The browser precomputes every step, so playing needs no server round trips.
    """
    html = PLAYER_TEMPLATE.read_text()
    html = html.replace("__CSS__", (SITE_DIR / "player.css").read_text())
    html = html.replace("__SCENE__", (SITE_DIR / "scene.js").read_text())
    html = html.replace("__PLAYER__", (SITE_DIR / "player.js").read_text())
    html = html.replace("__EVENTS__", json.dumps(playerEvents(run)).replace("</", "<\\/"))
    html = html.replace("__RELAYS__", json.dumps(run["relayNames"]))
    html = html.replace("__HOPS__", str(run["config"]["hops"]))
    return html


def runAsync(coroutine):
    """
    Helper function to run an async experiment from Streamlit's sync script.
    """
    return asyncio.run(coroutine)


def whoLabel(who):
    """
    Helper function: 'client' -> 'Client', relays stay R1, R2, ...
    """
    return who.capitalize() if who in ("client", "destination", "experiment") else who


# Page setup
st.set_page_config(page_title="Onion Routing Lab", layout="wide")
st.title("Onion Routing Lab")
st.caption("Real relays, a real directory and a real client, all running as asyncio servers on localhost. Change a setting and hit Run.")

# Sidebar : the basic knobs (defaults give a run of under 30 steps)
st.sidebar.header("Network settings")
hops = st.sidebar.slider("Hops in the circuit", 1, 5, 3)
poolSize = st.sidebar.slider("Relays in the pool", 3, 10, 5)
requests = st.sidebar.slider("Requests to send", 1, 6, 2)
delayMs = st.sidebar.slider("Delay per link (ms)", 0, 100, 20)

# Sidebar : advanced knobs, closed by default
with st.sidebar.expander("Advanced settings", expanded=False):
    lossPct = st.slider("Packet loss per relay (%)", 0, 30, 0)
    timeoutMs = st.slider("Client timeout (ms)", 100, 2000, 500, step=50)

    st.markdown("**Failure injection**")
    killOn = st.checkbox("Crash a relay mid-run", value=False)
    killAt = st.selectbox("...before request #", list(range(requests)), index=min(1, requests - 1))
    killHop = st.selectbox("...which hop dies (1 = entry)", list(range(1, hops + 1)), index=min(1, hops - 1))
    retry = st.radio("In-flight request policy", ["Retry once on a new circuit", "Fail with an error"]) == "Retry once on a new circuit"
    heartbeat = st.checkbox("Heartbeat (detect failure before next request)", value=False)

if killOn and poolSize < hops + 1:
    st.sidebar.warning("Pool is smaller than hops + 1, a failed relay cannot be replaced.")

config = {"hops": hops, "relays": poolSize, "delayMs": delayMs, "lossPct": lossPct, "requests": requests,
          "timeoutMs": timeoutMs, "killAt": killAt if killOn else None, "killHop": killHop - 1,
          "retry": retry, "heartbeat": heartbeat}

# Run : do the experiment, then build the browser player for it (it starts playing by itself)
if st.sidebar.button("Run", type="primary", width="stretch") or "run" not in st.session_state:
    with st.spinner("Starting relays and sending requests..."):
        st.session_state["run"] = runAsync(experiment.runExperiment(config))
    st.session_state["config"] = config
    st.session_state["playerHtml"] = buildPlayerHtml(st.session_state["run"])

run = st.session_state["run"]
events = run["events"]
results = run["results"]

# Telling the user how long the story is
if len(events) > MAX_EASY_STEPS:
    st.sidebar.warning(f"This run has {len(events)} steps. Lower the hops or requests to keep it easy to follow.")
else:
    st.sidebar.caption(f"This run has {len(events)} steps.")

tabFlow, tabLayers, tabLatency, tabFail, tabSaw = st.tabs(
    ["Message flow", "Layered encryption", "Latency vs hops", "Failures", "What each hop saw"])

# Tab 1 : step through the log
with tabFlow:
    st.write("Press Run in the sidebar and watch it play, one log event at a time. Pause any time, drag the slider or step with the buttons.")
    st.iframe(st.session_state["playerHtml"], height=PLAYER_HEIGHT)

# Tab 2 : what the layers look like
with tabLayers:
    st.write("Follow the first request. The client wraps it once per hop; each relay peels exactly one layer. "
             "Every cell on the wire is padded to 1024 bytes, so size does not give away the position.")
    wrapIndex = None
    for i in range(len(events)):
        if events[i]["kind"] == "wrap" and events[i]["cmd"] == "REQUEST":
            wrapIndex = i
            break

    if wrapIndex is None:
        st.warning("No request was sent.")
    else:
        wrap = events[wrapIndex]
        st.subheader("1. Client wraps the request (innermost layer first)")
        layerRows = []
        for layer in wrap["layers"]:
            layerRows.append({"layer for": layer["hop"], "ciphertext size (bytes)": layer["size"], "first bytes": layer["prefix"]})
        st.dataframe(pd.DataFrame(layerRows), hide_index=True, width="stretch")

        st.subheader("2. Each relay peels one layer")
        peelRows = []
        i = wrapIndex + 1
        while i < len(events) and events[i]["who"] != "client":
            e = events[i]
            if e["kind"] == "peel":
                peelRows.append({"relay": e["who"], "received": e["inPrefix"], "after peeling": e["outPrefix"],
                                 "size in": e["inSize"], "size out": e["outSize"]})
            if e["kind"] == "exit":
                peelRows.append({"relay": e["who"] + " (exit)", "received": "", "after peeling": f"plaintext: {e['payload']}",
                                 "size in": None, "size out": None})
            i += 1
        st.dataframe(pd.DataFrame(peelRows), hide_index=True, width="stretch")
        st.caption("The 'after peeling' bytes of one hop are the 'received' bytes of the next hop: that is the onion shrinking layer by layer.")

# Tab 3 : latency sweep
with tabLatency:
    st.write("Runs a fresh network for 1 to 5 hops using the current delay / loss settings (no crashes).")
    if st.button("Run latency sweep"):
        sweepConfig = dict(config)
        sweepConfig["requests"] = 8
        sweepConfig["heartbeat"] = False
        rows = runAsync(experiment.sweepHops(sweepConfig, [1, 2, 3, 4, 5], reps=2))
        st.session_state["sweep"] = pd.DataFrame(rows)

    if "sweep" in st.session_state:
        sweep = st.session_state["sweep"]
        table = sweep.groupby("hops").agg(latencyMs=("latencyMs", "mean"), spread=("latencyMs", "std"), buildMs=("buildMs", "mean"))
        fig, ax = plt.subplots(figsize=(7, 3.5))
        fig.patch.set_facecolor("white")
        ax.errorbar(table.index, table["latencyMs"], yerr=table["spread"].fillna(0), marker="o", color=BLUE, label="request latency", capsize=3)
        ax.plot(table.index, table["buildMs"], marker="s", color=RED, label="circuit build time")
        ax.set_xlabel("Number of hops")
        ax.set_ylabel("ms")
        ax.set_xticks([1, 2, 3, 4, 5])
        ax.legend()
        ax.spines[["top", "right"]].set_visible(False)
        st.pyplot(fig)
        st.dataframe(table.round(1), width="stretch")
        st.caption("Each extra hop adds two link crossings plus one more layer of crypto. Circuit setup grows faster because every hop needs a key exchange.")

# Tab 4 : failures
with tabFail:
    st.write("Latency of every request in the main run. Red = failed, orange = recovered by rebuilding the circuit.")
    fig, ax = plt.subplots(figsize=(8, 3.2))
    fig.patch.set_facecolor("white")
    for r in results:
        color = GREEN
        if not r["ok"]:
            color = RED
        elif r["attempts"] > 1:
            color = "#e08a1e"
        ax.bar(r["index"], r["latencyMs"], color=color)
    ax.set_xlabel("Request #")
    ax.set_ylabel("Latency (ms)")
    ax.spines[["top", "right"]].set_visible(False)
    st.pyplot(fig)

    detail = []
    for r in results:
        detail.append({"request": r["index"], "ok": r["ok"], "latency (ms)": round(r["latencyMs"]),
                       "attempts": r["attempts"], "circuit rebuilt": r["rebuilt"], "error": r["error"]})
    st.dataframe(pd.DataFrame(detail), hide_index=True, width="stretch")

    st.subheader("Failure timeline")
    start = events[0]["t"]
    timeline = []
    for i in range(len(events)):
        e = events[i]
        if e["kind"] in ("killed", "request_failed", "rebuild_start", "dead_found", "build_failed", "heartbeat_failed", "circuit_ready", "giving_up", "drop"):
            timeline.append({"t (ms)": round((e["t"] - start) * 1000), "who": whoLabel(e["who"]), "what": describe(events, i)})
    st.dataframe(pd.DataFrame(timeline), hide_index=True, width="stretch")

# Tab 5 : observability
with tabSaw:
    firstCircuit = None
    for e in events:
        if e["who"] == "client" and e["kind"] == "hop_added" and len(e["path"]) == run["config"]["hops"]:
            firstCircuit = e
            break

    if firstCircuit is None:
        st.warning("No complete circuit was built.")
    else:
        st.write(f"Circuit: client -> {' -> '.join(firstCircuit['path'])} -> destination")
        rows = analysis.whatEachHopSaw(events, firstCircuit["path"], firstCircuit["clientAddr"])
        table = pd.DataFrame(rows).rename(columns={"knowsClient": "knows client address", "knowsNextHop": "knows next hop",
                                                   "knowsDestination": "knows destination", "seesPlaintext": "sees plaintext"})
        st.dataframe(table, hide_index=True, width="stretch")

        st.subheader("Anonymity claims checked against the logs")
        for text, holds in analysis.checkClaims(rows):
            if holds:
                st.success(text)
            else:
                st.error(text)

        st.caption("Try 1 hop: the single relay sees everything, so claim 1 breaks. "
                   "Still true for any length: if the entry and exit are both malicious they can match traffic by timing, "
                   "the exit sees the plaintext request (no end-to-end TLS here), and a compromised directory could hand out only its own relays.")
