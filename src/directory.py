# Directory service: relays register here, clients ask for the list.

# Importing Modules
import sys
import json
import asyncio

import onion


# Defining Functions
async def startDirectory(port=0):
    """
    Input  : port to listen on (0 = let the OS pick)
    Output : the asyncio server. Protocol is one JSON line in, one JSON line out.
    """
    relays = {}   # name -> {name, host, port, pub}

    async def handle(reader, writer):
        line = await reader.readline()
        msg = json.loads(line)

        # A relay announcing itself
        if msg["op"] == "register":
            relays[msg["relay"]["name"]] = msg["relay"]
            reply = {"ok": True}
        # A client asking who is out there
        elif msg["op"] == "list":
            reply = {"relays": list(relays.values())}
        # A client saying this relay is dead
        elif msg["op"] == "remove":
            relays.pop(msg["name"], None)
            reply = {"ok": True}
        else:
            reply = {"ok": False}

        writer.write((json.dumps(reply) + "\n").encode())
        await writer.drain()
        writer.close()

    server = await asyncio.start_server(handle, "127.0.0.1", port)
    return server


async def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 9000
    server = await startDirectory(port)
    print(f"Directory listening on 127.0.0.1:{port}")
    await server.serve_forever()


if __name__ == "__main__":
    asyncio.run(main())
