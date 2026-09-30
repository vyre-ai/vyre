// IconCache: an IconSpec turned into the picture beside a row, drawn once at the size it is shown.
//
// Every picture is rendered into one bitmap of the row's point size times the screen's backing
// scale, and no larger: NSWorkspace's app icons carry reps up to 1024 px, and keeping those for a
// 20 pt row is most of an icon cache's memory. The bitmap is what is cached, in an NSCache bounded
// by count and by cost (its bytes), emptied when macOS reports memory pressure, and trimmed to the
// most recently used few on cool() so a hidden Capsule holds only what the next show draws first.
//
// Sources, by spec:
//   file(path)      the icon Finder shows for it; an image or PDF also gets a Quick Look
//                   thumbnail, asked for off the main thread at low priority, and `ready` is
//                   called with it when it lands (the type icon is drawn until then)
//   bundle(id)      the app's icon, found with urlForApplication(withBundleIdentifier:)
//   symbol(name)    an SF Symbol tinted with a token colour (docs/design/TOKENS.md)
//   contact(id)     the contact's thumbnail photo when access is granted (never asks), else initials
//   swatch, glyph   drawn here
//   mark            the Vyre mark: until the design board's mark ships as an asset, a signal-green
//                   sparkle symbol
//
// The cache key includes the file's mtime for file specs, so an updated app gets its new icon.

import AppKit
import Foundation
@preconcurrency import QuickLookThumbnailing
import UniformTypeIdentifiers

@MainActor
public final class IconCache {
    /// Drawn icons are rasterized, so they take the scheme at draw time, and it is part of their cache key.
    static var dark: Bool { Theme.isDark(NSApp?.effectiveAppearance ?? NSAppearance.currentDrawing()) }
    static var scheme: String { dark ? "d" : "l" }

    /// A tint in the current scheme: the dark values, or paper's (the same tokens as Theme).
    public static func color(_ t: Tint) -> NSColor {
        if !dark {
            switch t {
            case .bone: return rgb(0x141311)
            case .stone: return rgb(0x4A463F)
            case .ash: return rgb(0x6B665D)
            case .signal: return rgb(0x46700C)
            case .recall: return rgb(0x4A463F)
            case .attention: return rgb(0x5B3FC4)
            }
        }
        switch t {
        case .bone: return rgb(0xF1EEE6)
        case .stone: return rgb(0xB3AEA4)
        case .ash: return rgb(0x8C877D)
        case .signal: return rgb(0xC6F36B)
        case .recall: return rgb(0xB3AEA4) // Design A retired the gold: as stone
        case .attention: return rgb(0xB8A4FF)
        }
    }
    static func rgb(_ v: Int) -> NSColor {
        NSColor(srgbRed: CGFloat((v >> 16) & 0xff) / 255, green: CGFloat((v >> 8) & 0xff) / 255, blue: CGFloat(v & 0xff) / 255, alpha: 1)
    }

    private let cache = NSCache<NSString, NSImage>()
    /// Most recent last. May name keys NSCache already evicted; trim() only needs the order.
    private var order: [String] = []
    private var pending = Set<String>()
    private var pressure: DispatchSourceMemoryPressure?
    let contactPhoto: @Sendable (String) -> Data?
    /// How many entries cool() keeps.
    public var keepOnCool = 48
    public private(set) var renders = 0

    public init(countLimit: Int = 300, costLimit: Int = 12 << 20,
                contactPhoto: @escaping @Sendable (String) -> Data? = { _ in nil }) {
        cache.countLimit = countLimit
        cache.totalCostLimit = costLimit
        self.contactPhoto = contactPhoto
        // An event source, not a timer: it wakes only when macOS says memory is short.
        let src = DispatchSource.makeMemoryPressureSource(eventMask: [.warning, .critical], queue: .main)
        src.setEventHandler { [weak self] in MainActor.assumeIsolated { self?.purge() } }
        src.resume()
        pressure = src
    }

    deinit { pressure?.cancel() }

    /// Empty the cache (memory pressure).
    public func purge() {
        cache.removeAllObjects()
        order.removeAll()
    }

    /// Keep only the most recently used few (the Capsule hid).
    public func cool() {
        guard order.count > keepOnCool else { return }
        for k in order.dropLast(keepOnCool) { cache.removeObject(forKey: k as NSString) }
        order = Array(order.suffix(keepOnCool))
    }

    public func cached(_ key: String) -> NSImage? { cache.object(forKey: key as NSString) }
    public var count: Int { order.filter { cache.object(forKey: $0 as NSString) != nil }.count }

    func key(_ spec: IconSpec, px: Int) -> String {
        switch spec {
        case .file(let p):
            let m = ((try? FileManager.default.attributesOfItem(atPath: p))?[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0
            return "file:\(p):\(Int(m)):\(px)"
        case .bundle(let b): return "bundle:\(b):\(px)"
        case .symbol(let n, let t): return "symbol:\(n):\(t.rawValue):\(px):\(Self.scheme)"
        case .mark: return "mark:\(px):\(Self.scheme)"
        case .contact(let id, let i): return "contact:\(id):\(i):\(px):\(Self.scheme)"
        case .swatch(let r, let g, let b): return "swatch:\(r),\(g),\(b):\(px)"
        case .glyph(let s): return "glyph:\(s):\(px):\(Self.scheme)"
        case .none: return ""
        }
    }

    private func store(_ img: NSImage, _ key: String, px: Int) {
        cache.setObject(img, forKey: key as NSString, cost: px * px * 4)
        order.removeAll { $0 == key }
        order.append(key)
    }

    /// The picture for `spec` at `points` on a screen of `scale`. `ready` is called later with a
    /// better picture when one is on its way (a Quick Look thumbnail).
    public func image(_ spec: IconSpec, points: CGFloat, scale: CGFloat, ready: ((NSImage) -> Void)? = nil) -> NSImage? {
        let px = max(1, Int((points * scale).rounded()))
        let k = key(spec, px: px)
        if k.isEmpty { return nil }
        if let hit = cache.object(forKey: k as NSString) {
            order.removeAll { $0 == k }
            order.append(k)
            return hit
        }
        guard let img = render(spec, points: points, px: px) else { return nil }
        store(img, k, px: px)
        if case .file(let p) = spec, Self.wantsThumbnail(p) { thumbnail(p, key: k, points: points, scale: scale, px: px, ready: ready) }
        return img
    }

    static func wantsThumbnail(_ path: String) -> Bool {
        guard let t = UTType(filenameExtension: (path as NSString).pathExtension) else { return false }
        return t.conforms(to: .image) || t.conforms(to: .pdf)
    }

    private func thumbnail(_ path: String, key k: String, points: CGFloat, scale: CGFloat, px: Int, ready: ((NSImage) -> Void)?) {
        let tk = k + ":thumb"
        if let hit = cache.object(forKey: tk as NSString) { cache.setObject(hit, forKey: k as NSString, cost: px * px * 4); ready?(hit); return }
        guard pending.insert(tk).inserted else { return }
        let req = QLThumbnailGenerator.Request(fileAt: URL(fileURLWithPath: path), size: CGSize(width: points, height: points), scale: scale,
                                               representationTypes: .thumbnail)
        DispatchQueue.global(qos: .utility).async {
            QLThumbnailGenerator.shared.generateBestRepresentation(for: req) { rep, _ in
                let cg = rep?.cgImage
                DispatchQueue.main.async {
                    MainActor.assumeIsolated {
                        self.pending.remove(tk)
                        guard let cg else { return }
                        let src = NSImage(cgImage: cg, size: CGSize(width: cg.width, height: cg.height))
                        guard let img = Self.draw(px: px, points: points, { rect in Self.fit(src, in: rect, fill: false) }) else { return }
                        self.renders += 1
                        self.store(img, tk, px: px)
                        self.store(img, k, px: px)
                        ready?(img)
                    }
                }
            }
        }
    }

    func render(_ spec: IconSpec, points: CGFloat, px: Int) -> NSImage? {
        renders += 1
        switch spec {
        case .file(let p):
            guard FileManager.default.fileExists(atPath: p) else { return render(.symbol("doc", .ash), points: points, px: px) }
            let src = NSWorkspace.shared.icon(forFile: p)
            return Self.draw(px: px, points: points) { Self.fit(src, in: $0, fill: false) }
        case .bundle(let b):
            guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: b) else { return render(.symbol("app", .ash), points: points, px: px) }
            let src = NSWorkspace.shared.icon(forFile: url.path)
            return Self.draw(px: px, points: points) { Self.fit(src, in: $0, fill: false) }
        case .symbol(let name, let tint):
            return Self.symbol(name, tint: tint, points: points, px: px)
        case .mark:
            return Self.symbol("sparkle", tint: .signal, points: points, px: px)
        case .contact(let id, let initials):
            if let data = contactPhoto(id), let photo = NSImage(data: data) {
                return Self.draw(px: px, points: points) { rect in
                    NSBezierPath(ovalIn: rect).addClip()
                    Self.fit(photo, in: rect, fill: true)
                }
            }
            return Self.draw(px: px, points: points) { rect in
                Self.color(.ash).setFill()
                NSBezierPath(ovalIn: rect).fill()
                Self.text(initials, in: rect, size: rect.height * 0.42, color: Self.color(.bone), weight: .semibold)
            }
        case .swatch(let r, let g, let b):
            return Self.draw(px: px, points: points) { rect in
                NSColor(srgbRed: r, green: g, blue: b, alpha: 1).setFill()
                NSBezierPath(roundedRect: rect.insetBy(dx: rect.width * 0.08, dy: rect.height * 0.08), xRadius: rect.width * 0.22, yRadius: rect.height * 0.22).fill()
            }
        case .glyph(let s):
            return Self.draw(px: px, points: points) { rect in Self.text(s, in: rect, size: rect.height * 0.72, color: Self.color(.bone), weight: .regular) }
        case .none:
            return nil
        }
    }

    /// A px x px RGBA bitmap, drawn in pixels, wrapped as an image of `points`.
    static func draw(px: Int, points: CGFloat, _ body: (NSRect) -> Void) -> NSImage? {
        guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8, samplesPerPixel: 4,
                                         hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
              let ctx = NSGraphicsContext(bitmapImageRep: rep) else { return nil }
        // Drawn in pixels: the context takes the bitmap's size when it is made, so a point size set
        // on the rep first would shrink every icon into the bottom-left corner (swift/local.swift).
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = ctx
        ctx.imageInterpolation = .high
        body(NSRect(x: 0, y: 0, width: px, height: px))
        ctx.flushGraphics()
        NSGraphicsContext.restoreGraphicsState()
        rep.size = NSSize(width: points, height: points)
        let img = NSImage(size: rep.size)
        img.addRepresentation(rep)
        return img
    }

    /// `fill` crops to the square (photos); otherwise the image fits inside it, centred.
    static func fit(_ img: NSImage, in rect: NSRect, fill: Bool) {
        let w = max(img.size.width, 1), h = max(img.size.height, 1)
        let k = fill ? max(rect.width / w, rect.height / h) : min(rect.width / w, rect.height / h)
        let r = NSRect(x: rect.midX - w * k / 2, y: rect.midY - h * k / 2, width: w * k, height: h * k)
        img.draw(in: r, from: .zero, operation: .sourceOver, fraction: 1)
    }

    static func symbol(_ name: String, tint: Tint, points: CGFloat, px: Int) -> NSImage? {
        let cfg = NSImage.SymbolConfiguration(pointSize: CGFloat(px) * 0.62, weight: .regular)
        guard let base = NSImage(systemSymbolName: name, accessibilityDescription: nil) ?? NSImage(systemSymbolName: "questionmark.square.dashed", accessibilityDescription: nil),
              let sym = base.withSymbolConfiguration(cfg) else { return nil }
        return draw(px: px, points: points) { rect in
            fit(sym, in: rect.insetBy(dx: rect.width * 0.1, dy: rect.height * 0.1), fill: false)
            // The symbol is a template (black with alpha): paint the token colour over its shape only.
            color(tint).setFill()
            rect.fill(using: .sourceAtop)
        }
    }

    static func text(_ s: String, in rect: NSRect, size: CGFloat, color: NSColor, weight: NSFont.Weight) {
        let attrs: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: size, weight: weight), .foregroundColor: color]
        let str = NSAttributedString(string: s, attributes: attrs)
        let b = str.size()
        str.draw(at: NSPoint(x: rect.midX - b.width / 2, y: rect.midY - b.height / 2))
    }
}
