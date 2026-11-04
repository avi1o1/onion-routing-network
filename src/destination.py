# Destination service: answers one line with one line.

# Importing Modules
import sys
import asyncio

import onion


# Defining Functions
async def startDestination(port=0, delayMs=0):
    """
    Input  : port (0 = OS picks), artificial processing delay in ms
    Output : the asyncio server
    """

    async def handle(reader, writer):
        peer = writer.get_extra_info("peername")
        line = await reader.readline()
        text = line.decode().strip()

        # The destination only ever sees the exit relay's address, never the client's
        onion.logEvent("destination", kind="request", prev=f"{peer[0]}:{peer[1]}", payload=text)

        await asyncio.sleep(delayMs / 1000)
        writer.write(f"Hello from destination! You said: {text}\n".encode())
        await writer.drain()
        writer.close()

    server = await asyncio.start_server(handle, "127.0.0.1", port)
    return server


async def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 9100
    onion.LOG_FILE = "logs/destination.jsonl"
    server = await startDestination(port)
    print(f"Destination listening on 127.0.0.1:{port}")
    await server.serve_forever()


if __name__ == "__main__":
    asyncio.run(main())
