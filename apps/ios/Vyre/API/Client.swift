import Foundation

/// What went wrong, typed from vyred's envelope `{error:{code,message,methods?}}` or the network.
enum VyreError: Error, Equatable, LocalizedError, Sendable {
    /// A human-only tool with no (or a failed) proof. `methods` lists what the box would accept.
    case presenceRequired(message: String, methods: [String])
    case denied(String)
    /// The tailnet peer is not the box's owner.
    case notOwner(String)
    /// The Host header named something other than the box.
    case misdirected(String)
    /// The box could not be reached at all.
    case offline(String)
    case noSuchTool(String)
    case badInput(String)
    /// Any other error code the box sent.
    case failed(code: String, message: String)
    /// The person cancelled Face ID, or the task was cancelled.
    case cancelled

    var code: String {
        switch self {
        case .presenceRequired: "presence_required"
        case .denied: "denied"
        case .notOwner: "not_owner"
        case .misdirected: "misdirected"
        case .offline: "offline"
        case .noSuchTool: "no_such_tool"
        case .badInput: "bad_input"
        case .failed(let c, _): c
        case .cancelled: "cancelled"
        }
    }

    var message: String {
        switch self {
        case .presenceRequired(let m, _), .denied(let m), .notOwner(let m), .misdirected(let m), .offline(let m),
             .noSuchTool(let m), .badInput(let m), .failed(_, let m): m
        case .cancelled: "Cancelled."
        }
    }

    var errorDescription: String? { message }

    /// The box has not learned this yet: a tool it does not have, or an input it does not know.
    var isMissingFeature: Bool {
        if case .noSuchTool = self { return true }
        if case .badInput = self { return true }
        return false
    }

    static func from(code: String, message: String, methods: [String]) -> VyreError {
        switch code {
        case "presence_required": .presenceRequired(message: message, methods: methods)
        case "denied": .denied(message)
        case "not_owner": .notOwner(message)
        case "misdirected": .misdirected(message)
        case "no_such_tool": .noSuchTool(message)
        case "bad_input": .badInput(message)
        default: .failed(code: code, message: message)
        }
    }
}

/// How a call proves a person is there (ADR 0018 section 3).
enum Proof: Sendable, Equatable {
    case none
    /// Sign with this phone's device key; `reason` is what Face ID shows.
    case device(reason: String)
    /// A presence session opened earlier (vault reveals in a row), or a device proof if none is open.
    case session(reason: String)
    /// A one-time enrollment code, only for presence.enroll.
    case code(String)
}

/// Makes the `x-vyre-presence` header for one call. The device key implements it.
protocol PresenceSigner: Sendable {
    func deviceHeader(tool: String, input: JSON, reason: String) async throws -> String
    func sessionHeader() async -> String?
}

/// The box's address: a host name (and optional port) the app talks to over HTTPS. Plain HTTP only
/// to 127.0.0.1 in a debug build, for the test world.
struct BoxAddress: Sendable, Hashable, Codable {
    let url: URL

    var host: String { url.host ?? "" }
    var display: String { url.port.map { "\(host):\($0)" } ?? host }

    /// "alex.vyre.run", "https://alex.vyre.run/", a scanned QR's URL, or (debug) "http://127.0.0.1:4800".
    init?(_ raw: String) {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty else { return nil }
        if !s.contains("://") { s = "https://" + s }
        guard var c = URLComponents(string: s), let host = c.host, !host.isEmpty else { return nil }
        let scheme = c.scheme?.lowercased()
        if scheme == "http" {
            #if DEBUG
            guard host == "127.0.0.1" || host == "localhost" else { return nil }
            #else
            return nil
            #endif
        } else if scheme != "https" { return nil }
        c.path = ""
        c.query = nil
        c.fragment = nil
        c.user = nil
        c.password = nil
        guard let url = c.url else { return nil }
        self.url = url
    }
}

/// The only thing in the app that makes requests to the box (the same rule as deck/js/api.js).
/// Every POST sends `content-type: application/json` and no Origin, and never `x-vyre-caller`.
final class VyreClient: Sendable {
    let address: BoxAddress
    let signer: PresenceSigner?
    let session: URLSession

    init(address: BoxAddress, signer: PresenceSigner?, session: URLSession? = nil) {
        self.address = address
        self.signer = signer
        self.session = session ?? VyreClient.makeSession()
    }

    static func makeSession() -> URLSession {
        let c = URLSessionConfiguration.ephemeral
        c.httpCookieStorage = nil
        c.httpShouldSetCookies = false
        c.urlCache = nil
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        c.timeoutIntervalForRequest = 40
        c.waitsForConnectivity = false
        c.httpAdditionalHeaders = ["accept": "application/json"]
        return URLSession(configuration: c)
    }

    func url(_ path: String) -> URL { URL(string: path, relativeTo: address.url)!.absoluteURL }

    /// `POST /v1/tools/<name>`. Returns `data`, or throws the typed error.
    @discardableResult
    func call(_ tool: String, _ input: JSON = [:], proof: Proof = .none) async throws -> JSON {
        // The body is the canonical form itself, so the bytes sent are the bytes the proof hashed.
        let body = Data(input.canonical.utf8)
        var req = URLRequest(url: url("/v1/tools/\(tool)"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = body
        if let header = try await presenceHeader(tool: tool, input: input, proof: proof) {
            req.setValue(header, forHTTPHeaderField: "x-vyre-presence")
        }
        return try await send(req)
    }

    /// Call without a proof; if the box answers `presence_required`, sign once with the device key
    /// (Face ID shows `reason`) and send the byte-identical input again. Exactly one retry: a
    /// second refusal is thrown as it came.
    @discardableResult
    func callProvingIfAsked(_ tool: String, _ input: JSON = [:], reason: String) async throws -> JSON {
        do {
            return try await call(tool, input)
        } catch VyreError.presenceRequired {
            return try await call(tool, input, proof: .device(reason: reason))
        }
    }

    private func presenceHeader(tool: String, input: JSON, proof: Proof) async throws -> String? {
        switch proof {
        case .none: return nil
        case .code(let code): return "code code=\(code)"
        case .device(let reason):
            guard let signer else { throw VyreError.presenceRequired(message: "This phone has no key yet. Sign in first.", methods: []) }
            return try await signer.deviceHeader(tool: tool, input: input, reason: reason)
        case .session(let reason):
            guard let signer else { throw VyreError.presenceRequired(message: "This phone has no key yet. Sign in first.", methods: []) }
            if let s = await signer.sessionHeader() { return s }
            return try await signer.deviceHeader(tool: tool, input: input, reason: reason)
        }
    }

    /// `GET /v1/health`.
    func health() async throws -> JSON {
        try await send(URLRequest(url: url("/v1/health")))
    }

    /// `GET /v1/tools`: the tools this caller may use.
    func tools() async throws -> [String] {
        try await send(URLRequest(url: url("/v1/tools"))).list.compactMap { $0["name"].string }
    }

    func send(_ req: URLRequest) async throws -> JSON {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: req)
        } catch {
            throw VyreClient.transportError(error)
        }
        return try VyreClient.decode(data: data, status: (response as? HTTPURLResponse)?.statusCode ?? 0)
    }

    static func transportError(_ error: Error) -> VyreError {
        if error is CancellationError { return .cancelled }
        let ns = error as NSError
        if ns.domain == NSURLErrorDomain && ns.code == NSURLErrorCancelled { return .cancelled }
        return .offline("Could not reach the box. Is Tailscale connected?")
    }

    /// The envelope: `{data}` on success, `{error:{code,message,methods?}}` on failure.
    static func decode(data: Data, status: Int) throws -> JSON {
        let json: JSON
        do { json = try JSON.parse(data) } catch {
            if status == 0 || status >= 500 { throw VyreError.offline("The box answered with something that is not Vyre (\(status)).") }
            throw VyreError.failed(code: "bad_response", message: "The box answered with something that is not Vyre (\(status)).")
        }
        let err = json["error"]
        if !err.isNull {
            throw VyreError.from(code: err["code"].string ?? "failed", message: err["message"].string ?? "Failed.",
                                 methods: err["methods"].strings)
        }
        if case .object(let o) = json, let d = o["data"] { return d }
        throw VyreError.failed(code: "bad_response", message: "The box answered without data (\(status)).")
    }
}
