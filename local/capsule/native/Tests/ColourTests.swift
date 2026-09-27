// Colour tests: parsing every notation, the other forms, and the words that must not be colours.

import Foundation

// capsule-suite: colourSuite
let colourSuite = Suite("colour") { t in
    t.test("hex in, rgb and hsl out") {
        let c = Colour.evaluate("#ff6347")
        t.eq(c?.hex, "#FF6347")
        t.eq(c?.rgb, "rgb(255, 99, 71)")
        t.eq(c?.hsl, "hsl(9, 100%, 64%)")
        t.eq(c?.name, "tomato")
        t.eq(c?.forms.map(\.kind), ["rgb", "hsl", "name", "hex"], "the input's own form is last")
        t.eq(Colour.evaluate("#FFF")?.rgb, "rgb(255, 255, 255)")
        t.eq(Colour.evaluate("#fff")?.name, "white")
        let a = Colour.evaluate("#00000080")
        t.eq(a?.rgb, "rgba(0, 0, 0, 0.502)")
        t.eq(a?.hex, "#00000080")
        t.eq(a?.hsl, "hsla(0, 0%, 0%, 0.502)")
        t.ok(a?.name == nil, "a translucent colour has no CSS name")
        t.eq(Colour.evaluate("#123456")?.hsl, "hsl(210, 65%, 20%)")
    }

    t.test("rgb() in both syntaxes") {
        t.eq(Colour.evaluate("rgb(255, 99, 71)")?.hex, "#FF6347")
        t.eq(Colour.evaluate("rgb(255 99 71)")?.hex, "#FF6347")
        t.eq(Colour.evaluate("RGB( 255 , 99 , 71 )")?.hex, "#FF6347")
        t.eq(Colour.evaluate("rgba(255, 99, 71, 0.5)")?.hex, "#FF634780")
        t.eq(Colour.evaluate("rgb(255 99 71 / 50%)")?.rgb, "rgba(255, 99, 71, 0.5)")
        t.eq(Colour.evaluate("rgb(100%, 0%, 0%)")?.hex, "#FF0000")
    }

    t.test("hsl() in") {
        t.eq(Colour.evaluate("hsl(9, 100%, 64%)")?.hex, "#FF6347")
        t.eq(Colour.evaluate("hsl(120deg 100% 25%)")?.hex, "#008000")
        t.eq(Colour.evaluate("hsl(120deg 100% 25%)")?.name, "green")
        t.eq(Colour.evaluate("hsla(0, 0%, 50%, 0.25)")?.rgb, "rgba(128, 128, 128, 0.25)")
        t.eq(Colour.evaluate("hsl(-120, 100%, 50%)")?.hex, "#0000FF")
    }

    t.test("names need the word colour") {
        t.eq(Colour.evaluate("color tomato")?.hex, "#FF6347")
        t.eq(Colour.evaluate("colour rebecca purple")?.hex, "#663399")
        t.eq(Colour.evaluate("cornflowerblue colour")?.rgb, "rgb(100, 149, 237)")
        t.eq(Colour.evaluate("color cyan")?.name, "aqua")
        t.eq(Colour.names.count, 148)
    }

    t.test("not a colour is nil") {
        for q in ["", "red", "tomato", "cafe", "#", "#ff", "#ggg", "#fffff", "#fffffffff", "rgb", "rgb()", "rgb(1, 2)",
                  "rgb(256, 0, 0)", "rgb(-1, 0, 0)", "rgb(1, 2, 3, 4, 5)", "rgb(1,,2)", "rgba(0, 0, 0, 2)", "hsl(0, 200%, 50%)",
                  "hsl(0, 50, 50)", "color", "color narnia", "colour of money", "rgb(1, 2, 3) please", "#fff is white"] {
            let r = Colour.evaluate(q)
            t.ok(r == nil, "\(q) gave \(String(describing: r?.hex))")
        }
    }

    t.test("colourResult row carries every form") {
        guard let row = colourResult(Query("#ff6347")) else { t.ok(false, "no row"); return }
        t.eq(row.title, "rgb(255, 99, 71)")
        t.eq(row.subtitle, "hsl(9, 100%, 64%) · tomato · #FF6347")
        t.eq(row.copyText, "rgb(255, 99, 71)")
        t.eq(row.icon, .swatch(r: 1, g: 99.0 / 255, b: 71.0 / 255))
        t.eq(row.payload["hex"], "#FF6347")
        t.eq(row.payload["name"], "tomato")
        t.eq(row.section, .answer)
        t.eq(row.id, "colour:#FF6347")
    }
}
