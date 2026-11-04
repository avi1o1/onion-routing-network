# Reads the observation logs and checks the anonymity claims.

# Defining Functions
def whatEachHopSaw(events, path, clientAddr):
    """
    Input  : event list, relay names of one circuit (entry first), the client's address
    Output : one row per relay saying what it could observe
    """
    rows = []
    for position in range(len(path)):
        name = path[position]
        row = {"relay": name, "position": position + 1, "knowsClient": False, "knowsNextHop": False,
               "knowsDestination": False, "seesPlaintext": False}

        # Going through everything this relay logged
        for event in events:
            if event["who"] != name:
                continue
            if event["kind"] == "create" and event["prev"] == clientAddr:
                row["knowsClient"] = True
            if event["kind"] in ("extend", "linked"):
                row["knowsNextHop"] = True
            if event["kind"] == "exit":
                row["knowsDestination"] = True
                row["seesPlaintext"] = True
        rows.append(row)
    return rows


def checkClaims(rows):
    """
    Output: list of (claim text, True/False) for the anonymity claims.
    """
    entry = rows[0]
    exitRelay = rows[-1]

    # Claim 1 : nobody alone links the client to the destination
    linked = False
    for row in rows:
        if row["knowsClient"] and row["knowsDestination"]:
            linked = True

    # Claim 2 : middle relays know neither end
    middleClean = True
    for row in rows[1:-1]:
        if row["knowsClient"] or row["knowsDestination"] or row["seesPlaintext"]:
            middleClean = False

    claims = [
        ("No single relay knows both the client and the destination", not linked),
        ("Entry relay does not see the destination or the payload", not entry["knowsDestination"]),
        ("Exit relay does not know the client's address", not exitRelay["knowsClient"]),
        ("Middle relays know neither the client nor the destination", middleClean),
    ]
    return claims
