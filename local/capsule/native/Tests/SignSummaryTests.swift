// capsule-suite: signSummarySuite
// KP-3: the shell writes what the Touch ID sheet says from the bytes it signs, never from the page's caption, and refuses what it cannot read.

import Foundation

private func chain(_ json: String) -> Data { Data(("vyre-chain-v1\n" + json).utf8) }

let signSummarySuite = Suite("sign summary") { t in
    t.test("an identity-list change is summarised from its own bytes") {
        t.eq(SignSummary.of(message: chain(#"{"type":"add","entry":{"kind":"device","label":"Ana's iPhone"}}"#)), "Add a device: Ana's iPhone")
        t.eq(SignSummary.of(message: chain(#"{"type":"add","entry":{"kind":"owner","label":"Sam"}}"#)), "Make Sam an owner")
        t.eq(SignSummary.of(message: chain(#"{"type":"remove","target":"abc"}"#)), "Remove a sign-in (abc)")
        t.eq(SignSummary.of(message: chain(#"{"type":"replace-code","entry":{"kind":"code"}}"#)), "Replace your recovery code")
    }

    t.test("bytes the shell cannot read have no summary, so they are not signed") {
        t.eq(SignSummary.of(message: chain(#"{"type":"agree","target":"abc","agree":"x"}"#)), "Add a sharing key to this device")
        t.eq(SignSummary.of(message: chain(#"{"type":"agree","agree":"x"}"#)), nil)
        t.eq(SignSummary.of(message: chain(#"{"type":"mystery"}"#)), nil)
        t.eq(SignSummary.of(message: chain(#"{"type":"add","entry":{"kind":"robot"}}"#)), nil)
        t.eq(SignSummary.of(message: chain("{")), nil)
        t.eq(SignSummary.of(message: Data("Unlock Drive".utf8)), nil)
    }

    t.test("a label cannot add lines or length to the summary") {
        let s = SignSummary.of(message: chain(#"{"type":"add","entry":{"kind":"device","label":"A\nUnlock Drive\nxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}}"#)) ?? ""
        t.ok(!s.contains("\n"))
        t.ok(s.hasPrefix("Add a device: "))
        t.ok(s.count < 70)
    }

    t.test("the page's caption changes nothing: the summary is a function of the bytes alone") {
        // the bridge no longer reads `prompt` for the sheet
        MainActor.assumeIsolated {
            t.ok(VyreAppWindow.bridgeSource.contains("enclaveSign: function (message, prompt, card)"))
        }
        let m = chain(#"{"type":"add","entry":{"kind":"device","label":"Evil laptop"}}"#)
        t.eq(SignSummary.of(message: m), SignSummary.of(message: m, fields: ["prompt": "Unlock Drive"], space: "x"))
    }

    t.test("a yes-moment proof is summarised only when the card's fields hash to its payload_hash") {
        // kernel/seal/payloadhash-vectors.json, "empty fields"
        t.eq(SignSummary.payloadHash(op: "grant.invite", space: "spc_aaaaaaaaaaaa", fields: [:]), "ZLy1LQwY-00KVALmtNpi45C5M8X9spxqjZhoPnmqLA8")
        let proof = Data(#"{"decision":"grant.invite","nonce":"n","payload_hash":"ZLy1LQwY-00KVALmtNpi45C5M8X9spxqjZhoPnmqLA8"}"#.utf8)
        t.eq(SignSummary.of(message: proof, fields: [:], space: "spc_aaaaaaaaaaaa"), "Approve: grant.invite")
        t.eq(SignSummary.of(message: proof, fields: ["to": "someone else"], space: "spc_aaaaaaaaaaaa"), nil)
        t.eq(SignSummary.of(message: proof), nil)
    }
}
