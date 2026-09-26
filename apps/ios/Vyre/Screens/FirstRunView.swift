import AVFoundation
import SwiftUI

/// First run: find the box (a QR from the Deck's setup page, or a typed address), check it
/// answers, then sign in with the Deck's passkey so this phone's key is enrolled.
struct FirstRunView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.openURL) private var openURL
    @State private var typed = ""
    @State private var scanning = false
    @State private var busy = false
    @State private var line: String?
    @State private var offline = false
    @FocusState private var focused: Bool

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Space.l) {
                HStack(spacing: Space.s) { Mark(size: 20); Wordmark(height: 22) }
                    .padding(.top, Space.l)
                VStack(alignment: .leading, spacing: Space.s) {
                    Text("Find your box.").vyre(.h1).foregroundStyle(Color.bone)
                    Text("Scan the QR code on your Deck's setup page, or type the box's address. Only your tailnet can open it.")
                        .vyre(.body).foregroundStyle(Color.stone)
                }
                VStack(alignment: .leading, spacing: Space.s) {
                    Engraved("Address")
                    TextField("", text: $typed, prompt: Text("vyre.your-tailnet.ts.net").foregroundStyle(Color.ash))
                        .vyre(.code)
                        .foregroundStyle(Color.bone)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                        .submitLabel(.go)
                        .focused($focused)
                        .onSubmit { Task { await connect() } }
                        .padding(.horizontal, Space.m)
                        .frame(minHeight: Space.target)
                        .background(Color.panel, in: RoundedRectangle(cornerRadius: Radius.button))
                        .overlay {
                            RoundedRectangle(cornerRadius: Radius.button)
                                .strokeBorder(focused ? Color.signal : Color.ruleStrong, lineWidth: focused ? 2 : 1)
                        }
                        .accessibilityLabel("Box address")
                }
                HStack(spacing: Space.s) {
                    Button { Task { await connect() } } label: { Text(busy ? "Signing in" : "Sign in") }
                        .buttonStyle(.vyre(.primary, fill: true))
                        .disabled(busy || typed.trimmingCharacters(in: .whitespaces).isEmpty)
                    Button { scanning = true } label: { Label("Scan", systemImage: "qrcode.viewfinder") }
                        .buttonStyle(.secondary)
                        .disabled(busy)
                }
                if let line {
                    Text(line).vyre(.small).foregroundStyle(Color.stone).frame(maxWidth: .infinity, alignment: .leading)
                }
                if offline {
                    Button("Open Tailscale") { openURL(URL(string: "tailscale://")!) }.buttonStyle(.secondary)
                }
                Hairline()
                VStack(alignment: .leading, spacing: Space.s) {
                    Engraved("How signing in works")
                    Text("This phone makes a key that never leaves it. Your Deck's passkey approves it once; after that, Face ID on this phone approves drafts, answers sessions and opens the vault.")
                        .vyre(.small).foregroundStyle(Color.stone)
                }
            }
            .padding(.horizontal, Space.gutter)
        }
        .vyreGround()
        .sheet(isPresented: $scanning) {
            QRScanner { code in
                scanning = false
                typed = code
                Task { await connect() }
            }
            .ignoresSafeArea()
        }
        #if DEBUG
        .task { await testWorld() }
        #endif
    }

    private func connect() async {
        guard !busy else { return }
        guard let address = BoxAddress(typed) else { line = "That is not a box address. It looks like vyre.your-tailnet.ts.net."; return }
        busy = true
        offline = false
        defer { busy = false }
        let probe = VyreClient(address: address, signer: nil)
        do {
            line = "Looking for \(address.display)."
            _ = try await probe.health()
            let key = try DeviceKey.load() ?? DeviceKey.create()
            line = "Found it. Approve this phone with your passkey."
            let id = try await SignIn.run(address: address, key: key)
            try app.signedIn(address: address, key: key, id: id)
        } catch let e as VyreError {
            switch e {
            case .offline:
                offline = true
                line = "Could not reach \(address.display). Is Tailscale connected on this phone?"
            case .cancelled: line = "Sign-in cancelled. Nothing was enrolled."
            case .notOwner: line = "This box serves only its owner. Sign in to Tailscale as the owner."
            default: line = e.message
            }
        } catch {
            line = (error as? LocalizedError)?.errorDescription ?? "Sign-in failed."
        }
    }

    #if DEBUG
    /// `-VyreTestBox http://127.0.0.1:4800`: skip the QR, mint a code from the test world
    /// (`POST /__test/code`) or take `-VyreTestCode`, and enroll with it.
    private func testWorld() async {
        guard let raw = Launch.value("-VyreTestBox"), let address = BoxAddress(raw) else { return }
        typed = address.url.absoluteString
        busy = true
        defer { busy = false }
        do {
            let probe = VyreClient(address: address, signer: nil)
            _ = try await probe.health()
            var code = Launch.value("-VyreTestCode")
            if code == nil {
                var req = URLRequest(url: probe.url("/__test/code"))
                req.httpMethod = "POST"
                req.setValue("application/json", forHTTPHeaderField: "content-type")
                req.httpBody = Data("{}".utf8)
                let out = try await probe.send(req)
                code = out["code"].string
            }
            guard let code else { line = "The test world gave no code."; return }
            DeviceKey.delete()
            let key = try DeviceKey.create()
            let id = try await SignIn.enroll(client: probe, key: key, name: "iPhone (simulator)", code: code)
            try app.signedIn(address: address, key: key, id: id)
        } catch {
            line = "Test world: " + ((error as? LocalizedError)?.errorDescription ?? "\(error)")
        }
    }
    #endif
}

/// A camera view that reads one QR code holding `https://<address>`.
struct QRScanner: UIViewControllerRepresentable {
    let found: (String) -> Void

    func makeUIViewController(context: Context) -> ScannerController {
        let c = ScannerController()
        c.found = found
        return c
    }
    func updateUIViewController(_ controller: ScannerController, context: Context) {}

    final class ScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
        var found: ((String) -> Void)?
        private let session = AVCaptureSession()
        private var done = false

        override func viewDidLoad() {
            super.viewDidLoad()
            view.backgroundColor = Tone.graphite
            guard let device = AVCaptureDevice.default(for: .video), let input = try? AVCaptureDeviceInput(device: device),
                  session.canAddInput(input) else {
                let label = UILabel()
                label.text = "This device has no camera. Type the address instead."
                label.textColor = Tone.stoneDark
                label.numberOfLines = 0
                label.textAlignment = .center
                label.translatesAutoresizingMaskIntoConstraints = false
                view.addSubview(label)
                NSLayoutConstraint.activate([label.centerYAnchor.constraint(equalTo: view.centerYAnchor),
                                             label.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24),
                                             label.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -24)])
                return
            }
            session.addInput(input)
            let output = AVCaptureMetadataOutput()
            guard session.canAddOutput(output) else { return }
            session.addOutput(output)
            output.setMetadataObjectsDelegate(self, queue: .main)
            output.metadataObjectTypes = [.qr]
            let preview = AVCaptureVideoPreviewLayer(session: session)
            preview.videoGravity = .resizeAspectFill
            preview.frame = view.bounds
            view.layer.addSublayer(preview)
            let s = session
            DispatchQueue.global(qos: .userInitiated).async { s.startRunning() }
        }

        override func viewWillDisappear(_ animated: Bool) {
            super.viewWillDisappear(animated)
            let s = session
            DispatchQueue.global(qos: .userInitiated).async { s.stopRunning() }
        }

        nonisolated func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput objects: [AVMetadataObject], from connection: AVCaptureConnection) {
            let value = objects.compactMap { ($0 as? AVMetadataMachineReadableCodeObject)?.stringValue }.first
            MainActor.assumeIsolated {
                guard !done, let value, BoxAddress(value) != nil else { return }
                done = true
                found?(value)
            }
        }
    }
}
