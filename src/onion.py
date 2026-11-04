# Shared helpers for the onion routing demo: crypto, cell framing, logging.

# Importing Modules
import os
import json
import time
import asyncio

from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

# Defining Constants
CELL_SIZE = 1024          # every cell on the wire is exactly this many bytes
HEADER_SIZE = 3           # 1 byte cell type + 2 bytes body length

# Link-level cell types (visible to anyone watching a single link)
CREATE = 1                # client -> relay : my ephemeral public key
CREATED = 2               # relay -> client : my ephemeral public key
RELAY = 3                 # onion encrypted body

# Relay commands (only visible AFTER a hop peels its own layer)
EXTEND = 1
EXTENDED = 2
REQUEST = 3
RESPONSE = 4
PING = 5
PONG = 6
ERROR = 7
CMD_NAMES = {1: "EXTEND", 2: "EXTENDED", 3: "REQUEST", 4: "RESPONSE", 5: "PING", 6: "PONG", 7: "ERROR"}

# Logging: every component appends what it can observe here
EVENTS = []               # in-memory log (used by the dashboard)
LOG_FILE = None           # if set, events are also written as JSON lines


# Defining Functions
def logEvent(who, **fields):
    """
    Record one observation made by a component (client, relay, destination).
    """
    event = {"t": time.time(), "who": who}
    event.update(fields)
    EVENTS.append(event)

    # Also writing to disk when running as a separate process
    if LOG_FILE is not None:
        with open(LOG_FILE, "a") as f:
            f.write(json.dumps(event) + "\n")


def hexPrefix(data):
    """
    First 8 bytes of some data as hex, enough to show 'it looks different'.
    """
    return data[:8].hex()


# ---------- Keys ----------

def newKeyPair():
    """
    Output: (private key object, public key as 32 raw bytes)
    """
    priv = X25519PrivateKey.generate()
    pub = priv.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    return priv, pub


def dhExchange(priv, pubBytes):
    """
    X25519 Diffie-Hellman between our private key and their raw public key.
    """
    return priv.exchange(X25519PublicKey.from_public_bytes(pubBytes))


def deriveKeys(sharedSecret):
    """
    HKDF the DH output into two AES-256 keys: forward (client->exit) and backward.
    """
    material = HKDF(algorithm=hashes.SHA256(), length=64, salt=None, info=b"onion-demo").derive(sharedSecret)
    return material[:32], material[32:]


# ---------- One onion layer ----------

def makeNonce(counter):
    """
    AES-GCM needs a unique nonce per message. TCP keeps order, so a counter is enough.
    """
    return b"\x00" * 4 + counter.to_bytes(8, "big")


def sealLayer(key, counter, plaintext):
    """
    Add one layer of encryption (adds 16 bytes of auth tag).
    """
    return AESGCM(key).encrypt(makeNonce(counter), plaintext, None)


def openLayer(key, counter, ciphertext):
    """
    Peel one layer. Raises an error if the data was tampered with or the key is wrong.
    """
    return AESGCM(key).decrypt(makeNonce(counter), ciphertext, None)


# ---------- Fixed-size cells ----------

async def writeCell(writer, cellType, body):
    """
    Send one cell: header + body + random padding up to CELL_SIZE.
    """
    if len(body) > CELL_SIZE - HEADER_SIZE:
        raise ValueError("Oopsie Woopsie : payload too big for one cell.")

    header = bytes([cellType]) + len(body).to_bytes(2, "big")
    padding = os.urandom(CELL_SIZE - HEADER_SIZE - len(body))
    writer.write(header + body + padding)
    await writer.drain()


async def readCell(reader):
    """
    Output: (cellType, body) with the padding removed.
    """
    cell = await reader.readexactly(CELL_SIZE)
    cellType = cell[0]
    length = int.from_bytes(cell[1:3], "big")
    body = cell[HEADER_SIZE:HEADER_SIZE + length]
    return cellType, body


# ---------- Directory lookup ----------

async def askDirectory(directoryAddr, message):
    """
    Send one JSON line to the directory and return its JSON reply.
    """
    host, port = directoryAddr
    reader, writer = await asyncio.open_connection(host, port)
    writer.write((json.dumps(message) + "\n").encode())
    await writer.drain()
    line = await reader.readline()
    writer.close()
    return json.loads(line)
