# Relay: peels one onion layer and forwards the rest. Lock-step request/reply keeps it simple.

# Importing Modules
import sys
import json
import random
import asyncio

import onion
from onion import (CREATE, CREATED, RELAY, EXTEND, EXTENDED, REQUEST, RESPONSE, PING, PONG, ERROR)


# Defining Functions
async def startRelay(name, port=0, directoryAddr=None, delayMs=0, lossPct=0):
    """
    Input  : relay name, port (0 = OS picks), directory (host, port), per-link delay in ms,
             percentage of cells this relay randomly drops
    Output : a dict describing the relay. delayMs / lossPct can be changed later.
    """
    staticPriv, staticPub = onion.newKeyPair()
    relay = {"name": name, "delayMs": delayMs, "lossPct": lossPct, "writers": []}

    async def handle(reader, writer):
        await handleConnection(relay, staticPriv, reader, writer)

    server = await asyncio.start_server(handle, "127.0.0.1", port)
    relay["server"] = server
    relay["port"] = server.sockets[0].getsockname()[1]
    relay["info"] = {"name": name, "host": "127.0.0.1", "port": relay["port"], "pub": staticPub.hex()}

    # Telling the directory that we exist
    if directoryAddr is not None:
        await onion.askDirectory(directoryAddr, {"op": "register", "relay": relay["info"]})

    return relay


def killRelay(relay):
    """
    Simulate a crash: stop listening and drop every open connection.
    """
    relay["server"].close()
    for writer in relay["writers"]:
        writer.close()


async def linkDelay(relay):
    """
    Helper function to simulate network latency on one link crossing.
    """
    await asyncio.sleep(relay["delayMs"] / 1000)


async def handleConnection(relay, staticPriv, reader, writer):
    """
    One connection = one circuit passing through this relay.
    """
    me = relay["name"]
    peer = writer.get_extra_info("peername")
    prevAddr = f"{peer[0]}:{peer[1]}"
    relay["writers"].append(writer)

    nextReader = None
    nextWriter = None
    nextAddr = None
    fwdCount = 0
    bwdCount = 0

    try:
        # Step 1 : first cell must be CREATE, finish the key exchange
        cellType, body = await onion.readCell(reader)
        if cellType != CREATE:
            return

        ephPriv, ephPub = onion.newKeyPair()
        shared = onion.dhExchange(ephPriv, body) + onion.dhExchange(staticPriv, body)
        fwdKey, bwdKey = onion.deriveKeys(shared)
        await onion.writeCell(writer, CREATED, ephPub)
        onion.logEvent(me, kind="create", prev=prevAddr)

        # Step 2 : serve cells one by one
        while True:
            cellType, body = await onion.readCell(reader)
            await linkDelay(relay)

            # Randomly losing the cell (client will time out)
            if random.random() * 100 < relay["lossPct"]:
                onion.logEvent(me, kind="drop", prev=prevAddr)
                continue

            # Peeling our layer. Wrong key or tampering raises an error and ends the circuit.
            plain = onion.openLayer(fwdKey, fwdCount, body)
            fwdCount += 1

            if nextWriter is not None:
                # Not the last hop: pass the inner onion on and relay the reply back
                onion.logEvent(me, kind="peel", role="forward", prev=prevAddr, next=nextAddr,
                               inPrefix=onion.hexPrefix(body), outPrefix=onion.hexPrefix(plain),
                               inSize=len(body), outSize=len(plain))
                await onion.writeCell(nextWriter, RELAY, plain)
                replyType, reply = await onion.readCell(nextReader)
                await linkDelay(relay)
                answer = onion.sealLayer(bwdKey, bwdCount, reply)
                bwdCount += 1
                await onion.writeCell(writer, RELAY, answer)
                continue

            # We are the last hop, the cell is for us
            cmd = plain[0]
            data = plain[1:]
            replyCmd = ERROR
            replyData = b"unknown command"

            if cmd == EXTEND:
                # Extend the circuit: open a link to the next relay and hand over the client's key
                target = json.loads(data)
                onion.logEvent(me, kind="extend", prev=prevAddr, next=f"{target['host']}:{target['port']}")
                try:
                    nextReader, nextWriter = await asyncio.open_connection(target["host"], target["port"])
                    await onion.writeCell(nextWriter, CREATE, bytes.fromhex(target["clientPub"]))
                    createdType, theirPub = await onion.readCell(nextReader)
                    sock = nextWriter.get_extra_info("sockname")
                    nextAddr = f"{target['host']}:{target['port']}"
                    onion.logEvent(me, kind="linked", localAddr=f"{sock[0]}:{sock[1]}", next=nextAddr)
                    replyCmd = EXTENDED
                    replyData = theirPub
                except (OSError, asyncio.IncompleteReadError):
                    nextWriter = None
                    replyData = b"could not reach next relay"

            elif cmd == REQUEST:
                # We are the exit: talk to the destination on behalf of an unknown client
                req = json.loads(data)
                onion.logEvent(me, kind="exit", prev=prevAddr, dest=req["dest"], payload=req["payload"])
                destHost, destPort = req["dest"].split(":")
                try:
                    destReader, destWriter = await asyncio.open_connection(destHost, int(destPort))
                    destWriter.write((req["payload"] + "\n").encode())
                    await destWriter.drain()
                    line = await destReader.readline()
                    destWriter.close()
                    replyCmd = RESPONSE
                    replyData = line.strip()
                except OSError:
                    replyData = b"destination unreachable"

            elif cmd == PING:
                onion.logEvent(me, kind="ping", prev=prevAddr)
                replyCmd = PONG
                replyData = b""

            await linkDelay(relay)
            answer = onion.sealLayer(bwdKey, bwdCount, bytes([replyCmd]) + replyData)
            bwdCount += 1
            await onion.writeCell(writer, RELAY, answer)

    except (asyncio.IncompleteReadError, ConnectionError, OSError):
        # Previous or next hop went away: just close
        pass
    except Exception as err:
        # Bad key / tampered cell
        onion.logEvent(me, kind="error", detail=str(err) or type(err).__name__)
    finally:
        writer.close()
        if nextWriter is not None:
            nextWriter.close()


async def main():
    name = sys.argv[1]
    port = int(sys.argv[2])
    directoryPort = int(sys.argv[3]) if len(sys.argv) > 3 else 9000
    delayMs = float(sys.argv[4]) if len(sys.argv) > 4 else 0
    onion.LOG_FILE = f"logs/{name}.jsonl"
    relay = await startRelay(name, port, ("127.0.0.1", directoryPort), delayMs)
    print(f"Relay {name} listening on 127.0.0.1:{relay['port']}")
    await relay["server"].serve_forever()


if __name__ == "__main__":
    asyncio.run(main())
