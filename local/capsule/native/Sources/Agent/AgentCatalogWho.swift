// Who a thread is, in the words people use: the agent whose thread it is, else the thread's name.

import Foundation

extension VyreCatalog {
    func who(_ thread: String?) -> String? {
        guard let t = thread, !t.isEmpty else { return nil }
        if let a = agents?.first(where: { $0.thread == t }) { return a.name }
        return self.thread(t)?.label
    }

    /// A project's name from its slug, for the lines people read.
    func projectName(_ slug: String) -> String { project(slug)?.name ?? slug }
}
