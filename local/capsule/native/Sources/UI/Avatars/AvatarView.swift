// AvatarView: an identity mark (Sources/Core/Avatars) drawn in SwiftUI.
//
// One geometry source: the view draws the very SVG string Avatars.svg returns, the Deck's markup
// byte for byte, through AppKit's own SVG support (NSImage reads SVG data from macOS 14, the
// Capsule's floor). So the vector tests on the string also cover what is drawn; nothing is
// restated as Paths.
//
// Cheap enough for list rows: each (kind, size, ring, scale) is parsed and rendered once into a
// bitmap of the shown size times the backing scale, and the bitmap is cached (count-bounded,
// emptied under memory pressure by NSCache itself). A mark that fails to parse draws the first
// letter of its seed, as the Deck's fallback does.

import AppKit
import SwiftUI

@MainActor
public final class AvatarImages {
    public static let shared = AvatarImages()
    private let cache = NSCache<NSString, NSImage>()

    init(limit: Int = 256) { cache.countLimit = limit }

    /// The bitmap for a kind at a point size and backing scale, or nil when its SVG does not parse.
    public func image(_ kind: AvatarKind, size: CGFloat, ring: Bool = false, scale: CGFloat = 2) -> NSImage? {
        let key = "\(Avatars.key(kind, size: Double(size), ring: ring))|\(size)|\(scale)" as NSString
        if let hit = cache.object(forKey: key) { return hit }
        guard let image = Self.render(Avatars.svg(kind, size: Double(size), ring: ring), size: size, scale: scale) else { return nil }
        cache.setObject(image, forKey: key)
        return image
    }

    /// An SVG drawn into a bitmap `size` points square at `scale` pixels per point.
    static func render(_ svg: String, size: CGFloat, scale: CGFloat) -> NSImage? {
        guard size > 0, let vector = NSImage(data: Data(svg.utf8)) else { return nil }
        let px = max(1, Int((size * scale).rounded()))
        guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8,
                                         samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                         colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
              let ctx = NSGraphicsContext(bitmapImageRep: rep) else { return nil }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = ctx
        ctx.imageInterpolation = .high
        vector.draw(in: NSRect(x: 0, y: 0, width: px, height: px))
        NSGraphicsContext.restoreGraphicsState()
        rep.size = NSSize(width: size, height: size)
        let image = NSImage(size: rep.size)
        image.addRepresentation(rep)
        return image
    }
}

public struct AvatarView: View {
    let kind: AvatarKind
    let size: CGFloat
    let ring: Bool
    let label: String?
    @Environment(\.displayScale) private var scale

    /// `ring`: the person's Vyre code, drawn only at Avatars.ringAt and up with a real
    /// fingerprint. `label`: the name to read out; without one the mark is decorative (the name
    /// sits beside it).
    public init(_ kind: AvatarKind, size: CGFloat = 24, ring: Bool = false, label: String? = nil) {
        self.kind = kind; self.size = size; self.ring = ring; self.label = label
    }

    public var body: some View {
        Group {
            if let image = AvatarImages.shared.image(kind, size: size, ring: ring, scale: scale) {
                Image(nsImage: image).resizable().interpolation(.high)
            } else {
                Text(fallback).font(.system(size: size * 0.5, weight: .medium)).foregroundStyle(Theme.stone)
            }
        }
        .frame(width: size, height: size)
        .accessibilityElement()
        .accessibilityLabel(label ?? "")
        .accessibilityHidden(label == nil)
    }

    private var fallback: String {
        let seed: String
        switch kind {
        case .person(_, let name), .assistant(_, let name): seed = name ?? ""
        case .agent(let s), .teammate(let s, _), .project(let s, _): seed = s
        }
        return String((label ?? seed).trimmingCharacters(in: .whitespaces).prefix(1)).lowercased().ifEmpty("?")
    }
}

private extension String {
    func ifEmpty(_ other: String) -> String { isEmpty ? other : self }
}
