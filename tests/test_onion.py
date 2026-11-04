# Tests for crypto layers, circuit setup, failure policy and anonymity claims.
# Run with:  pytest tests

# Importing Modules
import os
import sys
import asyncio

import pytest
from cryptography.exceptions import InvalidTag

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

import onion
import experiment
import analysis


# Defining Helper Functions
def run(config):
    """
    Helper function to run one experiment synchronously.
    """
    return asyncio.run(experiment.runExperiment(config))


def circuitOf(result):
    """
    Helper function to find the first complete circuit in the logs.
    """
    for e in result["events"]:
        if e["who"] == "client" and e["kind"] == "hop_added" and len(e["path"]) == result["config"]["hops"]:
            return e
    return None


# Crypto tests
def test_key_exchange_both_sides_agree():
    clientPriv, clientPub = onion.newKeyPair()
    relayPriv, relayPub = onion.newKeyPair()
    assert onion.dhExchange(clientPriv, relayPub) == onion.dhExchange(relayPriv, clientPub)


def test_layers_peel_in_order_and_tampering_is_caught():
    keys = [os.urandom(32) for _ in range(3)]
    cell = b"secret"
    for key in reversed(keys):
        cell = onion.sealLayer(key, 0, cell)

    # Peeling with the wrong key fails
    with pytest.raises(InvalidTag):
        onion.openLayer(keys[1], 0, cell)

    # Flipping a bit fails
    broken = bytes([cell[0] ^ 1]) + cell[1:]
    with pytest.raises(InvalidTag):
        onion.openLayer(keys[0], 0, broken)

    # Peeling in the right order works
    for key in keys:
        cell = onion.openLayer(key, 0, cell)
    assert cell == b"secret"


# Circuit tests
@pytest.mark.parametrize("hops", [1, 2, 3, 4])
def test_request_goes_end_to_end(hops):
    result = run({"hops": hops, "requests": 2, "delayMs": 0})
    for r in result["results"]:
        assert r["ok"]
        assert "message" in r["response"]


def test_anonymity_claims_hold_for_three_hops():
    result = run({"hops": 3, "requests": 1, "delayMs": 0})
    circuit = circuitOf(result)
    rows = analysis.whatEachHopSaw(result["events"], circuit["path"], circuit["clientAddr"])
    for text, holds in analysis.checkClaims(rows):
        assert holds, text


def test_one_hop_breaks_anonymity():
    result = run({"hops": 1, "requests": 1, "delayMs": 0})
    circuit = circuitOf(result)
    rows = analysis.whatEachHopSaw(result["events"], circuit["path"], circuit["clientAddr"])
    claims = analysis.checkClaims(rows)
    assert claims[0][1] is False


def test_destination_never_sees_client_address():
    result = run({"hops": 3, "requests": 1, "delayMs": 0})
    circuit = circuitOf(result)
    for e in result["events"]:
        if e["who"] == "destination":
            assert e["prev"] != circuit["clientAddr"]


# Failure tests
def test_retry_policy_recovers_from_dead_relay():
    result = run({"hops": 3, "relays": 6, "requests": 4, "killAt": 2, "killHop": 1, "retry": True})
    assert all(r["ok"] for r in result["results"])
    assert result["results"][2]["attempts"] == 2


def test_fail_policy_returns_clear_error_then_recovers():
    result = run({"hops": 3, "relays": 6, "requests": 4, "killAt": 2, "killHop": 1, "retry": False})
    failed = result["results"][2]
    assert failed["ok"] is False
    assert "Circuit broken" in failed["error"] or "Timed out" in failed["error"]
    # The circuit was rebuilt in the background, so the next request works
    assert result["results"][3]["ok"]


def test_heartbeat_rebuilds_before_next_request():
    result = run({"hops": 3, "relays": 6, "requests": 4, "killAt": 2, "killHop": 0, "heartbeat": True})
    assert all(r["ok"] for r in result["results"])
    assert result["results"][2]["attempts"] == 1
