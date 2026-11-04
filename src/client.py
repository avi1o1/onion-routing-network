# Client: builds a circuit hop by hop, wraps requests in onion layers, recovers from dead relays.

# Importing Modules
import sys
import json
import time
import random
import asyncio

import onion
from onion import (CREATE, CREATED, RELAY, EXTEND, EXTENDED, REQUEST, RESPONSE, PING, PONG, ERROR)


# Defining Functions
def makeClient(directoryAddr, hops=3, timeoutMs=1000):
    """
    Output: a dict holding all client state (circuit, keys, settings).
    """
    return {"directory": directoryAddr, "hops": hops, "timeout": timeoutMs / 1000,
            "path": [], "keys": [], "reader": None, "writer": None, "addr": None,
            "lock": asyncio.Lock(), "heartbeatTask": None}


async def closeCircuit(client):
    """
    Helper function to throw away the current circuit.
    """
    if client["writer"] is not None:
        client["writer"].close()
    client["writer"] = None
    client["reader"] = None
    client["path"] = []
    client["keys"] = []


async def sendOnion(client, cmd, data):
    """
    Wrap (cmd, data) for the LAST hop of the circuit, send it, and peel the reply.
    Output: (reply cmd, reply data). Raises an error on timeout, closed link or bad crypto.
    """
    # Step 1 : wrap, innermost layer is for the last hop, outermost for the entry relay
    cell = bytes([cmd]) + data
    last = len(client["keys"]) - 1
    layers = []
    for i in range(last, -1, -1):
        hop = client["keys"][i]
        cell = onion.sealLayer(hop["fwd"], hop["fwdCount"], cell)
        hop["fwdCount"] += 1
        layers.append({"hop": client["path"][i]["name"], "size": len(cell), "prefix": onion.hexPrefix(cell)})
    onion.logEvent("client", kind="wrap", cmd=onion.CMD_NAMES[cmd], layers=layers)

    # Step 2 : send it and wait for the reply
    await onion.writeCell(client["writer"], RELAY, cell)
    cellType, reply = await asyncio.wait_for(onion.readCell(client["reader"]), client["timeout"])

    # Step 3 : peel the reply, entry relay's layer is the outermost
    for i in range(last + 1):
        hop = client["keys"][i]
        reply = onion.openLayer(hop["bwd"], hop["bwdCount"], reply)
        hop["bwdCount"] += 1

    return reply[0], reply[1:]


async def buildCircuit(client):
    """
    Pick relays from the directory and extend the circuit one hop at a time.
    Raises an error if any hop cannot be reached.
    """
    await closeCircuit(client)
    start = time.time()

    # Step 1 : ask the directory who is alive and pick random relays
    answer = await onion.askDirectory(client["directory"], {"op": "list"})
    relays = answer["relays"]
    if len(relays) < client["hops"]:
        raise RuntimeError(f"Not enough relays: need {client['hops']}, directory has {len(relays)}")
    chosen = random.sample(relays, client["hops"])
    onion.logEvent("client", kind="build", path=[], names=[r["name"] for r in chosen])

    # Step 2 : each hop gets a fresh ephemeral key pair; we derive the same keys as the relay
    for i in range(len(chosen)):
        relayInfo = chosen[i]
        priv, pub = onion.newKeyPair()

        if i == 0:
            # Entry relay: direct CREATE over a fresh TCP connection
            reader, writer = await asyncio.wait_for(
                asyncio.open_connection(relayInfo["host"], relayInfo["port"]), client["timeout"])
            client["reader"] = reader
            client["writer"] = writer
            sock = writer.get_extra_info("sockname")
            client["addr"] = f"{sock[0]}:{sock[1]}"
            await onion.writeCell(writer, CREATE, pub)
            cellType, theirPub = await asyncio.wait_for(onion.readCell(reader), client["timeout"])
        else:
            # Later hops: ask the current last relay to EXTEND to the next one
            target = {"host": relayInfo["host"], "port": relayInfo["port"], "clientPub": pub.hex()}
            replyCmd, theirPub = await sendOnion(client, EXTEND, json.dumps(target).encode())
            if replyCmd != EXTENDED:
                raise RuntimeError("Extend failed: " + theirPub.decode())

        # Mixing ephemeral + the relay's long-term key (from the directory) into the session keys
        shared = onion.dhExchange(priv, theirPub) + onion.dhExchange(priv, bytes.fromhex(relayInfo["pub"]))
        fwdKey, bwdKey = onion.deriveKeys(shared)
        client["keys"].append({"fwd": fwdKey, "bwd": bwdKey, "fwdCount": 0, "bwdCount": 0})
        client["path"].append(relayInfo)
        onion.logEvent("client", kind="hop_added", path=[r["name"] for r in client["path"]],
                       clientAddr=client["addr"])

    buildMs = (time.time() - start) * 1000
    onion.logEvent("client", kind="circuit_ready", path=[r["name"] for r in client["path"]], buildMs=buildMs)
    return buildMs


async def findDeadRelays(client):
    """
    Probe each relay of the broken circuit with a plain TCP connect, tell the directory about dead ones.
    """
    dead = []
    for relayInfo in client["path"]:
        try:
            r, w = await asyncio.wait_for(asyncio.open_connection(relayInfo["host"], relayInfo["port"]), 0.3)
            w.close()
        except (OSError, asyncio.TimeoutError):
            dead.append(relayInfo["name"])
            await onion.askDirectory(client["directory"], {"op": "remove", "name": relayInfo["name"]})
    onion.logEvent("client", kind="dead_found", dead=dead)
    return dead


async def rebuildCircuit(client):
    """
    Detect dead relays and build a brand new circuit, retrying a few times.
    """
    onion.logEvent("client", kind="rebuild_start")
    await findDeadRelays(client)
    for attempt in range(3):
        try:
            await buildCircuit(client)
            return True
        except Exception as err:
            onion.logEvent("client", kind="build_failed", detail=str(err) or type(err).__name__)
            await findDeadRelays(client)
    return False


async def request(client, dest, payload, retry=True):
    """
    Send one request through the circuit.
    Policy for in-flight requests: if the circuit breaks, rebuild and retry ONCE (retry=True),
    otherwise fail with a clear error.
    Output: dict with ok, response, error, latencyMs, attempts, rebuilt
    """
    async with client["lock"]:
        start = time.time()
        attempts = 0
        rebuilt = False
        error = ""
        maxAttempts = 2 if retry else 1

        while attempts < maxAttempts:
            attempts += 1
            try:
                if client["writer"] is None:
                    await buildCircuit(client)
                body = json.dumps({"dest": dest, "payload": payload}).encode()
                replyCmd, replyData = await sendOnion(client, REQUEST, body)
                if replyCmd != RESPONSE:
                    raise RuntimeError(replyData.decode())
                latency = (time.time() - start) * 1000
                onion.logEvent("client", kind="response", text=replyData.decode(), latencyMs=latency)
                return {"ok": True, "response": replyData.decode(), "error": "", "latencyMs": latency,
                        "attempts": attempts, "rebuilt": rebuilt}
            except Exception as err:
                # Turning low level errors into something readable
                if isinstance(err, asyncio.IncompleteReadError) or isinstance(err, ConnectionError):
                    error = "Circuit broken: a relay on the path closed the connection"
                elif isinstance(err, asyncio.TimeoutError):
                    error = "Timed out waiting for a reply (relay dead or cell lost)"
                else:
                    error = f"{type(err).__name__}: {err}"
                onion.logEvent("client", kind="request_failed", attempt=attempts, detail=error)
                # Circuit is broken (or desynced), rebuild before anything else
                rebuilt = await rebuildCircuit(client)

        latency = (time.time() - start) * 1000
        onion.logEvent("client", kind="giving_up", detail=error)
        return {"ok": False, "response": "", "error": error, "latencyMs": latency,
                "attempts": attempts, "rebuilt": rebuilt}


async def heartbeatLoop(client, intervalMs):
    """
    Background task: ping through the circuit every interval, rebuild proactively if it fails.
    """
    while True:
        await asyncio.sleep(intervalMs / 1000)
        async with client["lock"]:
            if client["writer"] is None:
                continue
            try:
                replyCmd, data = await sendOnion(client, PING, b"")
                if replyCmd != PONG:
                    raise RuntimeError("bad pong")
            except Exception:
                onion.logEvent("client", kind="heartbeat_failed")
                await rebuildCircuit(client)


def startHeartbeat(client, intervalMs):
    """
    Helper function to start the heartbeat task.
    """
    client["heartbeatTask"] = asyncio.create_task(heartbeatLoop(client, intervalMs))


async def main():
    directoryPort = int(sys.argv[1]) if len(sys.argv) > 1 else 9000
    destPort = int(sys.argv[2]) if len(sys.argv) > 2 else 9100
    hops = int(sys.argv[3]) if len(sys.argv) > 3 else 3
    onion.LOG_FILE = "logs/client.jsonl"
    client = makeClient(("127.0.0.1", directoryPort), hops)
    for i in range(3):
        result = await request(client, f"127.0.0.1:{destPort}", f"hello {i}")
        print(result)
    await closeCircuit(client)


if __name__ == "__main__":
    asyncio.run(main())
