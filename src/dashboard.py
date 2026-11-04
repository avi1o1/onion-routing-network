# Interactive dashboard: tweak the network, run real relays/client, watch what happens.
# Run with:  streamlit run src/dashboard.py

# Importing Modules
import math
import asyncio

import streamlit as st
import pandas as pd
import matplotlib
import matplotlib.pyplot as plt

import experiment
import analysis

# Defining Constants
BLUE = "#2a6fdb"        # active circuit
GREY = "#b8bcc4"        # idle relays
RED = "#d6453d"         # dead relays / failures
GREEN = "#2f9e5b"       # success
CLIENT_POS = (0.0, 0.5)
DEST_POS = (1.0, 0.5)


# Defining Functions
def relayPositions(names):
    """
    Place the relay pool on a circle between the client (left) and destination (right).
    """
    positions = {}
    for i in range(len(names)):
        angle = 2 * math.pi * i / len(names) + math.pi / 2
        positions[names[i]] = (0.5 + 0.28 * math.cos(angle), 0.5 + 0.38 * math.sin(angle))
    positions["client"] = CLIENT_POS
    positions["destination"] = DEST_POS
    return positions


def describe(e):
    """
    Turn one log event into a short plain-English sentence.
    """
    who = e["who"]
    kind = e["kind"]
    if kind == "build":
        return f"Client picked relays {e['names']} from the directory"
    if kind == "hop_added":
        return f"Circuit extended: client -> {' -> '.join(e['path'])}"
    if kind == "circuit_ready":
        return f"Circuit ready ({e['buildMs']:.0f} ms to build)"
    if kind == "wrap":
        return f"Client wrapped {e['cmd']} in {len(e['layers'])} encryption layer(s)"
    if kind == "create":
        return f"{who} did a key exchange with {e['prev']}"
    if kind == "extend":
        return f"{who} was told to extend to {e['next']}"
    if kind == "linked":
        return f"{who} opened a link to {e['next']}"
    if kind == "peel":
        return f"{who} peeled its layer ({e['inSize']} -> {e['outSize']} bytes) and forwarded it"
    if kind == "exit":
        return f"{who} (exit) sends '{e['payload']}' to {e['dest']}"
    if kind == "ping":
        return f"{who} (last hop) answered a heartbeat ping"
    if kind == "drop":
        return f"{who} dropped a cell (packet loss)"
    if kind == "error":
        return f"{who} rejected a cell: {e['detail']}"
    if kind == "request":
        return f"Destination got '{e['payload']}' from {e['prev']} (the exit relay)"
    if kind == "response":
        return f"Client received the reply in {e['latencyMs']:.0f} ms"
    if kind == "killed":
        return f"{e['name']} CRASHED"
    if kind == "request_failed":
        return f"Request attempt {e['attempt']} failed: {e['detail']}"
    if kind == "rebuild_start":
        return "Client is rebuilding the circuit"
    if kind == "dead_found":
        return f"Client found dead relays: {e['dead']}"
    if kind == "build_failed":
        return f"Circuit build failed: {e['detail']}"
    if kind == "heartbeat_failed":
        return "Heartbeat failed, rebuilding"
    if kind == "giving_up":
        return "Request failed (no more retries)"
    return kind


def stateAtStep(events, step):
    """
    Replay the log up to `step` to know the current circuit path and which relays are dead.
    """
    path = []
    dead = []
    for e in events[:step + 1]:
        if e["who"] == "client" and "path" in e:
            path = e["path"]
        if e["kind"] == "killed":
            dead.append(e["name"])
    return path, dead


def drawNetwork(run, step):
    """
    Draw the relay pool, the current circuit and the node that just did something.
    """
    events = run["events"]
    names = run["relayNames"]
    positions = relayPositions(names)
    path, dead = stateAtStep(events, step)
    active = events[step]["who"]

    fig, ax = plt.subplots(figsize=(8, 4.4))
    fig.patch.set_facecolor("white")

    # Circuit edges
    chain = ["client"] + path
    if len(path) > 0:
        chain.append("destination")
    for i in range(len(chain) - 1):
        a = positions[chain[i]]
        b = positions[chain[i + 1]]
        ax.annotate("", xy=b, xytext=a, arrowprops=dict(arrowstyle="->", color=BLUE, lw=2, shrinkA=14, shrinkB=14))

    # Nodes
    for name in positions:
        x, y = positions[name]
        color = GREY
        if name in path or name == "client" or name == "destination":
            color = BLUE
        if name in dead:
            color = RED
        size = 900 if name == active else 500
        ax.scatter([x], [y], s=size, color=color, zorder=3, edgecolors="black" if name == active else "none", linewidths=2)
        label = name
        if name in path:
            label = f"{name}\nhop {path.index(name) + 1}"
        ax.text(x, y - 0.09, label, ha="center", va="top", fontsize=8, color="#222")
        if name in dead:
            ax.text(x, y, "X", ha="center", va="center", color="white", fontsize=10, fontweight="bold", zorder=4)

    ax.set_xlim(-0.1, 1.1)
    ax.set_ylim(0.0, 1.05)
    ax.axis("off")
    return fig


def runAsync(coroutine):
    """
    Helper function to run an async experiment from Streamlit's sync script.
    """
    return asyncio.run(coroutine)


# Page setup
st.set_page_config(page_title="Onion Routing Lab", layout="wide")
st.title("Onion Routing Lab")
st.caption("Real relays, a real directory and a real client, all running as asyncio servers on localhost. Change a setting and hit Run.")

# Sidebar : the knobs
st.sidebar.header("Network settings")
hops = st.sidebar.slider("Hops in the circuit", 1, 5, 3)
poolSize = st.sidebar.slider("Relays in the pool", 3, 10, 6)
delayMs = st.sidebar.slider("Delay per link (ms)", 0, 100, 10)
lossPct = st.sidebar.slider("Packet loss per relay (%)", 0, 30, 0)
requests = st.sidebar.slider("Requests to send", 1, 20, 6)
timeoutMs = st.sidebar.slider("Client timeout (ms)", 100, 2000, 500, step=50)

st.sidebar.header("Failure injection")
killOn = st.sidebar.checkbox("Crash a relay mid-run", value=True)
killAt = st.sidebar.slider("...before request #", 0, max(requests - 1, 0), min(2, requests - 1))
killHop = st.sidebar.slider("...which hop dies (1 = entry)", 1, hops, min(2, hops))
retry = st.sidebar.radio("In-flight request policy", ["Retry once on a new circuit", "Fail with an error"]) == "Retry once on a new circuit"
heartbeat = st.sidebar.checkbox("Heartbeat (detect failure before next request)", value=False)

if poolSize < hops + 1:
    st.sidebar.warning("Pool is smaller than hops + 1, a failed relay cannot be replaced.")

config = {"hops": hops, "relays": poolSize, "delayMs": delayMs, "lossPct": lossPct, "requests": requests,
          "timeoutMs": timeoutMs, "killAt": killAt if killOn else None, "killHop": killHop - 1,
          "retry": retry, "heartbeat": heartbeat}

if st.sidebar.button("Run", type="primary", width="stretch") or "run" not in st.session_state:
    st.session_state["run"] = runAsync(experiment.runExperiment(config))
    st.session_state["config"] = config

run = st.session_state["run"]
events = run["events"]
results = run["results"]

# Headline numbers
okResults = [r for r in results if r["ok"]]
meanLatency = sum(r["latencyMs"] for r in okResults) / len(okResults) if okResults else 0
col1, col2, col3, col4 = st.columns(4)
col1.metric("Succeeded", f"{len(okResults)} / {len(results)}")
col2.metric("Mean latency", f"{meanLatency:.0f} ms")
col3.metric("Circuit build", f"{run['buildMs']:.0f} ms" if run["buildMs"] else "-")
col4.metric("Retried requests", sum(1 for r in results if r["attempts"] > 1))

tabFlow, tabLayers, tabLatency, tabFail, tabSaw = st.tabs(
    ["Message flow", "Layered encryption", "Latency vs hops", "Failures", "What each hop saw"])

# Tab 1 : step through the log
with tabFlow:
    st.write("Scrub through everything that happened, one log event at a time.")
    step = st.slider("Step", 0, len(events) - 1, 0)
    left, right = st.columns([3, 2])
    with left:
        st.pyplot(drawNetwork(run, step))
    with right:
        st.subheader(f"Step {step}")
        st.info(describe(events[step]))
        start = events[0]["t"]
        rows = []
        for i in range(max(0, step - 9), step + 1):
            rows.append({"t (ms)": round((events[i]["t"] - start) * 1000), "who": events[i]["who"], "what": describe(events[i])})
        st.dataframe(pd.DataFrame(rows), hide_index=True, width="stretch")

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
    for e in events:
        if e["kind"] in ("killed", "request_failed", "rebuild_start", "dead_found", "build_failed", "heartbeat_failed", "circuit_ready", "giving_up", "drop"):
            timeline.append({"t (ms)": round((e["t"] - start) * 1000), "who": e["who"], "what": describe(e)})
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
        st.write(f"Circuit: client ({firstCircuit['clientAddr']}) -> {' -> '.join(firstCircuit['path'])} -> destination ({run['destAddr']})")
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
