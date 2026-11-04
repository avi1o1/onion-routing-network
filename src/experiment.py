# Spins up a whole network (directory, relays, destination, client) inside one process and runs requests.
# Same relay/client code as the standalone scripts, just started as asyncio tasks on random ports.

# Importing Modules
import asyncio

import onion
import client as clientLib
from directory import startDirectory
from relay import startRelay, killRelay
from destination import startDestination


# Defining Constants
DEFAULT_CONFIG = {
    "hops": 3,            # circuit length
    "relays": 6,          # relays in the pool
    "delayMs": 5,         # per-link delay at every relay
    "lossPct": 0,         # % of cells each relay drops
    "requests": 5,        # how many requests the client sends
    "timeoutMs": 500,     # client waits this long for a reply
    "killAt": None,       # request number (0-based) before which a relay is killed, None = never
    "killHop": 1,         # which hop of the circuit dies (0 = entry)
    "retry": True,        # in-flight policy: retry once on a new circuit, else fail
    "heartbeat": False,   # run a heartbeat that rebuilds the circuit before the next request
}
HEARTBEAT_MS = 100


# Defining Functions
async def runExperiment(config):
    """
    Input  : config dict (see DEFAULT_CONFIG)
    Output : dict with per-request results, events, relay names, client and destination addresses
    """
    cfg = dict(DEFAULT_CONFIG)
    cfg.update(config)
    onion.EVENTS.clear()

    # Step 1 : start directory, relays and destination
    directory = await startDirectory()
    directoryAddr = ("127.0.0.1", directory.sockets[0].getsockname()[1])
    relays = {}
    for i in range(cfg["relays"]):
        name = f"R{i + 1}"
        relays[name] = await startRelay(name, 0, directoryAddr, cfg["delayMs"], cfg["lossPct"])
    destination = await startDestination()
    destAddr = f"127.0.0.1:{destination.sockets[0].getsockname()[1]}"

    # Step 2 : client builds a circuit and sends requests
    client = clientLib.makeClient(directoryAddr, cfg["hops"], cfg["timeoutMs"])
    if cfg["heartbeat"]:
        clientLib.startHeartbeat(client, HEARTBEAT_MS)

    results = []
    buildMs = None
    for i in range(cfg["requests"]):
        # Killing a relay of the current circuit just before this request
        if cfg["killAt"] == i and client["path"]:
            victim = client["path"][min(cfg["killHop"], len(client["path"]) - 1)]["name"]
            killRelay(relays[victim])
            onion.logEvent("experiment", kind="killed", name=victim)
            # Giving the heartbeat time to notice (if it is on)
            if cfg["heartbeat"]:
                await asyncio.sleep(HEARTBEAT_MS * 4 / 1000)

        result = await clientLib.request(client, destAddr, f"message {i}", cfg["retry"])
        result["index"] = i
        results.append(result)

    # Step 3 : collecting circuit build time and tearing everything down
    for event in onion.EVENTS:
        if event["who"] == "client" and event["kind"] == "circuit_ready" and buildMs is None:
            buildMs = event["buildMs"]
    if client["heartbeatTask"] is not None:
        client["heartbeatTask"].cancel()
    clientAddr = client["addr"]
    await clientLib.closeCircuit(client)
    for relay in relays.values():
        killRelay(relay)
    directory.close()
    destination.close()
    await asyncio.sleep(0.05)

    return {"results": results, "events": list(onion.EVENTS), "relayNames": list(relays.keys()),
            "destAddr": destAddr, "buildMs": buildMs, "config": cfg}


async def sweepHops(config, hopsList, reps=1):
    """
    Run the same experiment for several path lengths.
    Output: list of rows {hops, latencyMs, buildMs}
    """
    rows = []
    for hops in hopsList:
        for rep in range(reps):
            cfg = dict(config)
            cfg["hops"] = hops
            cfg["relays"] = max(cfg.get("relays", 6), hops)
            cfg["killAt"] = None
            run = await runExperiment(cfg)
            for r in run["results"]:
                if r["ok"]:
                    rows.append({"hops": hops, "latencyMs": r["latencyMs"], "buildMs": run["buildMs"]})
    return rows


def main():
    # Quick command line version of the latency evaluation
    import pandas as pd
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    rows = asyncio.run(sweepHops({"delayMs": 5, "requests": 10}, [1, 2, 3, 4], reps=2))
    table = pd.DataFrame(rows).groupby("hops").mean()
    print(table)

    plt.plot(table.index, table["latencyMs"], marker="o", label="request latency")
    plt.plot(table.index, table["buildMs"], marker="s", label="circuit build time")
    plt.xlabel("Number of hops")
    plt.ylabel("ms")
    plt.legend()
    plt.savefig("latency.png", dpi=120)
    print("Saved latency.png")


if __name__ == "__main__":
    main()
