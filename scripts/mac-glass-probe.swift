// mac-glass-probe: two small jobs for scripts/capsule-native-check.mjs (CI, macOS only), so the Deep glass skin is
// proved on the built app, not from source.
//
//   mac-glass-probe backdrop white|black|split   a borderless window the size of the main screen, filled with the
//                                                colour, kept at normal level so the Lumen panel (floating) sits over it.
//                                                Prints "ready" once it is up, then waits to be killed.
//   mac-glass-probe luma file.png                mean luma 0...255 of the picture, then of its left and right
//                                                halves, as "mean left right".
import AppKit

let args = CommandLine.arguments
guard args.count >= 3 else { FileHandle.standardError.write(Data("usage: backdrop <white|black|split> | luma <png>\n".utf8)); exit(2) }

if args[1] == "luma" {
    guard let img = NSImage(contentsOfFile: args[2]), let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else { print("error: cannot read \(args[2])"); exit(1) }
    let w = cg.width, h = cg.height
    var px = [UInt8](repeating: 0, count: w * h * 4)
    let ctx = CGContext(data: &px, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: CGColorSpaceCreateDeviceRGB(),
                        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
    var sum = 0.0, left = 0.0, right = 0.0, n = 0.0, nl = 0.0, nr = 0.0
    for y in 0..<h { for x in 0..<w {
        let i = (y * w + x) * 4
        if px[i + 3] < 250 { continue }   // the rounded corners and the shadow are not the ground
        let l = 0.2126 * Double(px[i]) + 0.7152 * Double(px[i + 1]) + 0.0722 * Double(px[i + 2])
        sum += l; n += 1
        if x < w / 2 { left += l; nl += 1 } else { right += l; nr += 1 }
    } }
    func f(_ v: Double, _ c: Double) -> String { String(format: "%.2f", c > 0 ? v / c : -1) }
    print("\(f(sum, n)) \(f(left, nl)) \(f(right, nr))")
    exit(0)
}

guard args[1] == "backdrop" else { exit(2) }
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let screen = NSScreen.main!
let win = NSWindow(contentRect: screen.frame, styleMask: .borderless, backing: .buffered, defer: false)
win.isOpaque = true
win.hasShadow = false
win.level = .normal
win.ignoresMouseEvents = true
win.collectionBehavior = [.canJoinAllSpaces, .stationary]
final class Fill: NSView {
    let mode: String
    init(_ f: NSRect, _ m: String) { mode = m; super.init(frame: f) }
    required init?(coder: NSCoder) { fatalError() }
    override func draw(_ r: NSRect) {
        let white = NSColor.white, black = NSColor.black
        switch mode {
        case "white": white.setFill(); bounds.fill()
        case "black": black.setFill(); bounds.fill()
        default:
            white.setFill(); NSRect(x: 0, y: 0, width: bounds.width / 2, height: bounds.height).fill()
            black.setFill(); NSRect(x: bounds.width / 2, y: 0, width: bounds.width / 2, height: bounds.height).fill()
        }
    }
}
win.contentView = Fill(NSRect(origin: .zero, size: screen.frame.size), args[2])
win.orderFrontRegardless()
DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { print("ready"); fflush(stdout) }
app.run()
