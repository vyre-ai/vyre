// Harness: the Capsule's tests without XCTest (the Command Line Tools do not always carry it).
//
// A test file declares one suite as a global and marks it for the runner, which build.sh finds by
// the marker and calls in order:
//
//     // capsule-suite: calcSuite
//     let calcSuite = Suite("calc") { t in
//         t.test("adds") { t.eq(Calc.evaluate("1+2")?.value, 3) }
//     }
//
// `./build.sh test [filter]` compiles every source except the app's entry point with the tests,
// runs them, and exits non-zero on any failure. Async work: t.wait { await ... } blocks until done.

import Foundation

public final class Suite: @unchecked Sendable {
    let name: String
    let body: (Suite) -> Void
    var failures: [String] = []
    var passed = 0
    var current = ""
    var filter: String?

    public init(_ name: String, _ body: @escaping (Suite) -> Void) { self.name = name; self.body = body }

    static let trace = ProcessInfo.processInfo.environment["GITHUB_ACTIONS"] != nil || ProcessInfo.processInfo.environment["VYRE_CAPSULE_TRACE"] == "1"

    public func test(_ title: String, _ fn: () throws -> Void) {
        if let f = filter, !"\(name) \(title)".localizedCaseInsensitiveContains(f) { return }
        current = title
        // On CI, say which test runs, so a crash (which prints nothing else) names its test.
        if Suite.trace { FileHandle.standardError.write(Data("# \(name) · \(title)\n".utf8)) }
        let before = failures.count
        do { try fn() } catch { failures.append("\(name) · \(title): threw \(error)") }
        if failures.count == before { passed += 1 }
    }

    public func eq<T: Equatable>(_ a: T?, _ b: T?, _ note: String = "", file: StaticString = #fileID, line: UInt = #line) {
        if a != b { failures.append("\(name) · \(current): \(String(describing: a)) != \(String(describing: b)) \(note) (\(file):\(line))") }
    }

    public func ok(_ cond: Bool, _ note: String = "", file: StaticString = #fileID, line: UInt = #line) {
        if !cond { failures.append("\(name) · \(current): expected true \(note) (\(file):\(line))") }
    }

    public func near(_ a: Double?, _ b: Double, _ eps: Double = 1e-9, file: StaticString = #fileID, line: UInt = #line) {
        guard let a, abs(a - b) <= eps * max(1, abs(b)) else {
            failures.append("\(name) · \(current): \(String(describing: a)) is not near \(b) (\(file):\(line))"); return
        }
    }

    /// Run async work to completion from a synchronous test.
    public func wait<T: Sendable>(timeout: TimeInterval = 10, _ fn: @escaping @Sendable () async -> T) -> T? {
        let box = ResultBox<T>()
        let sem = DispatchSemaphore(value: 0)
        Task.detached { box.value = await fn(); sem.signal() }
        // Keep the main run loop turning so @MainActor work inside fn can finish.
        let until = Date().addingTimeInterval(timeout)
        while sem.wait(timeout: .now()) == .timedOut {
            if Date() > until { failures.append("\(name) · \(current): timed out after \(timeout)s"); return nil }
            RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.01))
        }
        return box.value
    }

    func run(filter: String?) -> (passed: Int, failures: [String]) {
        self.filter = filter
        body(self)
        return (passed, failures)
    }
}

final class ResultBox<T>: @unchecked Sendable { var value: T? }

/// Called by the generated TestMain.swift.
public func runSuites(_ suites: [Suite]) -> Never {
    // The suites written before #46 test the memory-first order; the new default has its own tests, which set the flag off.
    CapsuleModel.memoryFirstDefault = true
    let args = CommandLine.arguments.dropFirst()
    let filter = args.first
    var passed = 0, failed: [String] = []
    for s in suites {
        let r = s.run(filter: filter)
        passed += r.passed
        failed += r.failures
    }
    for f in failed { FileHandle.standardError.write(Data(("not ok  " + f + "\n").utf8)) }
    print("capsule native tests: \(passed) passed, \(failed.count) failed")
    exit(failed.isEmpty ? 0 : 1)
}
