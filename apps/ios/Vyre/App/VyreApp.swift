import SwiftUI

@main
struct VyreApp: App {
    var body: some Scene {
        WindowGroup {
            VStack(spacing: Space.gutter) {
                Mark(size: 36)
                Wordmark(height: 22)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .vyreGround()
        }
    }
}
