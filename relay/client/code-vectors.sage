# Independent vectors for relay/client/code.js, from the CFRG SageMath reference of draft-irtf-cfrg-cpace.
#
# Run it on the test box (never on the Mac), inside the sagemath image:
#   in the reference checkout (draft-irtf-cfrg-cpace/poc), preparse every .sage there and in its two submodules into sagelib/ (the Makefile's pyfiles step)
#   cp <repo>/relay/client/code-vectors.sage . && sage code-vectors.sage > code-vectors.json
# then copy code-vectors.json to relay/client/code-vectors.json. The sources and commits it was run against are in team/0.3/PAKE-choice.md.
#
# What comes from the reference (poc/CPace_coffee.sage, class G_CoffeeEcosystem over Ed25519Point = ristretto255, hash H_SHA512):
#   the generator g, Ya, Yb, K and ISK, for OUR password, session id, channel identifiers and associated data, not the draft's fixed ones.
# What comes from this script's own plain Python (hmac, hashlib; written from reading code.js, so it is a second reading, not a reference):
#   everything after the ISK: the transcript hash, the two confirmation tags, the number, the sealing key, the typed-back code, the ticket seed.
# The inputs are fixed by a seeded generator so the file is reproducible.

import sys, json, hmac, hashlib, random
sys.path.append("sagelib")
from sagelib.CPace_string_utils import *
from sagelib.CPace_hashing import *
from sagelib.CPace_coffee import *

ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
LABEL = b"vyre-wink-code-v1"
ID_TYPIST = b"vyre-wink-typist"
ID_SHOWING = b"vyre-wink-showing"
ORDER = (1 << 252) + 27742317777372353535851937790883648493

H = H_SHA512()
G = G_CoffeeEcosystem(Ed25519Point)
assert G.DSI == b"CPaceRistretto255", G.DSI
assert G.DSI_ISK == b"CPaceRistretto255_ISK"

def h(b): return hashlib.sha512(b).digest()
def hmac512(key, msg): return hmac.new(key, msg, hashlib.sha512).digest()

CI = lv_cat(ID_TYPIST, ID_SHOWING)
AD_TYPIST = LABEL + b"/typist"

def ack_code(key):
    d = hmac512(key, b"vyre-wink-ack-v1")
    bits, acc, out = 0, 0, ""
    for x in d:
        acc = ((acc << 8) | x) & 0xffffffff
        bits += 8
        while bits >= 5 and len(out) < 8:
            out += ALPHABET[(acc >> (bits - 5)) & 31]; bits -= 5
        if len(out) >= 8: break
    return "WINK-" + out[:4] + "-" + out[4:8]

rng = random.Random("vyre-wink-code-vectors-v1")
cases = []
for n in range(10):
    rv = "".join(rng.choice(ALPHABET) for _ in range(2))
    pw = "".join(rng.choice(ALPHABET) for _ in range(6))
    nonce = bytes(rng.randrange(256) for _ in range(16))
    route = "".join(rng.choice("abcdefghijklmnopqrstuvwxyz234567") for _ in range(26))
    ya = IntegerToByteArray(int.from_bytes(bytes(rng.randrange(256) for _ in range(32)), "little") % ORDER, 32)
    yb = IntegerToByteArray(int.from_bytes(bytes(rng.randrange(256) for _ in range(32)), "little") % ORDER, 32)
    sid = lv_cat(LABEL, nonce, rv.encode())
    adb = lv_cat(LABEL + b"/showing", route.encode())
    g = G.calculate_generator(H, pw.encode(), CI, sid)
    Ya = G.scalar_mult(ya, g)
    Yb = G.scalar_mult(yb, g)
    K1 = G.scalar_mult_vfy(ya, Yb)
    K2 = G.scalar_mult_vfy(yb, Ya)
    assert K1 == K2
    tr = transcript_ir(Ya, AD_TYPIST, Yb, adb)
    ISK = H.hash(lv_cat(G.DSI_ISK, sid, K1) + tr)
    th = h(LABEL + b"/transcript" + sid + tr)
    mac = lambda label, *more: hmac512(ISK, LABEL + b"/" + label + th + b"".join(more))
    tagT = mac(b"confirm-typist")[:32]
    tagS = mac(b"confirm-showing", tagT)[:32]
    nb = mac(b"number")
    number = "%03d" % (int.from_bytes(nb[:4], "big") % 1000)
    key = mac(b"seal")[:32]
    seed = hmac512(key, b"vyre-wink-ticket-seed-v1")[:16]
    cases.append({
        "pw": pw, "rv": rv, "route": route,
        "nonce": bytes(nonce).hex(), "ya": bytes(ya).hex(), "yb": bytes(yb).hex(),
        "sid": sid.hex(), "ci": CI.hex(), "adTypist": AD_TYPIST.hex(), "adShowing": adb.hex(),
        "g": bytes(g).hex(), "Ya": bytes(Ya).hex(), "Yb": bytes(Yb).hex(), "K": bytes(K1).hex(),
        "transcript": tr.hex(), "isk": bytes(ISK).hex(),
        "tagT": tagT.hex(), "tagS": tagS.hex(), "number": number, "key": key.hex(),
        "ack": ack_code(key), "seed": seed.hex(),
    })

print(json.dumps({"reference": "draft-irtf-cfrg-cpace poc, G_CoffeeEcosystem(Ed25519Point), H_SHA512", "cases": cases}, indent=1))
