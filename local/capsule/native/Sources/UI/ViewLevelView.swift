// ViewLevelView: a module command's detail, form or preview, in the panel's own type and tokens
// (Host/ViewSession.swift). A module supplies words and fields; it never styles. Every string here
// is drawn as text, whatever it says.

import SwiftUI

struct ViewLevelView: View {
    @ObservedObject var session: ViewSession
    var submit: () -> Void = {}
    @FocusState private var focused: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                switch session.level {
                case .detail(let d, let row)?: detail(d, row)
                case .form(let f)?: form(f)
                case .preview(let p, _)?: preview(p)
                default: EmptyView()
                }
                if let p = session.problem { Label(p, systemImage: "exclamationmark.circle").font(Theme.subtitle).foregroundColor(Theme.stone) }
            }
            .padding(Theme.inset)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxHeight: .infinity, alignment: .top)
    }

    private func heading(_ s: String, from: String?) -> some View {
        HStack(spacing: 8) {
            Text(s).font(Theme.type(Tokens.TypeScale.read, .semibold)).foregroundColor(Theme.bone).lineLimit(2)
            Spacer(minLength: 0)
            if let from { Text("from \(from)").font(Theme.subtitle).foregroundColor(Theme.ash) }
        }
    }

    // MARK: detail

    @ViewBuilder private func detail(_ d: ViewDetail, _ row: ViewRow) -> some View {
        heading(d.title, from: d.from)
        ForEach(Array(d.fields.enumerated()), id: \.offset) { _, f in
            HStack(alignment: .top, spacing: 10) {
                Text(f.label).font(Theme.label).foregroundColor(Theme.ash).frame(width: 84, alignment: .leading)
                Text(f.value).font(Theme.title).foregroundColor(Theme.bone).textSelection(.enabled)
            }
        }
        if !d.body.isEmpty { Text(d.body).font(Theme.reply).foregroundColor(DeepGlass.ink).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }
        if !d.actions.isEmpty {
            HStack(spacing: 8) {
                ForEach(Array(d.actions.enumerated()), id: \.offset) { i, a in
                    Button(a.title) { Task { _ = await session.act(a, row: row) } }
                        .buttonStyle(OversightButton(primary: i == 0))
                }
            }
        }
    }

    // MARK: form

    @ViewBuilder private func form(_ f: ViewForm) -> some View {
        heading(f.title, from: nil)
        ForEach(f.fields, id: \.name) { field in
            VStack(alignment: .leading, spacing: 4) {
                Text(field.label + (field.required ? " *" : "")).font(Theme.label).foregroundColor(Theme.ash)
                control(field)
            }
        }
        HStack {
            Text("Return \(f.outward ? "checks it first" : f.submitTitle.lowercased()) \u{00B7} Esc goes back").font(Theme.subtitle).foregroundColor(Theme.ash)
            Spacer()
        }
        .onAppear { focused = f.fields.first?.name }
    }

    @ViewBuilder private func control(_ field: ViewField) -> some View {
        let text = Binding(get: { session.values[field.name] ?? "" }, set: { session.values[field.name] = $0 })
        switch field.kind {
        case .multiline:
            TextEditor(text: text).font(Theme.type(Tokens.TypeScale.read)).scrollContentBackground(.hidden).focused($focused, equals: field.name)
                .frame(height: 96).padding(6).background(box)
        case .choice:
            Picker("", selection: text) { ForEach(field.choices, id: \.self) { Text($0).tag($0) } }.labelsHidden().pickerStyle(.menu)
        case .bool:
            Toggle("", isOn: Binding(get: { session.values[field.name] == "true" }, set: { session.values[field.name] = $0 ? "true" : "false" })).labelsHidden()
        case .number, .text:
            TextField(field.label, text: text).textFieldStyle(.plain).font(Theme.type(Tokens.TypeScale.read)).foregroundColor(Theme.bone)
                .focused($focused, equals: field.name).onSubmit(submit)
                .padding(.horizontal, 12).frame(height: Tokens.Control.sm).background(box)
        }
    }

    private var box: some View {
        RoundedRectangle(cornerRadius: Tokens.Radius.field, style: .continuous).fill(Theme.raised)
            .overlay(RoundedRectangle(cornerRadius: Tokens.Radius.field, style: .continuous).strokeBorder(Theme.ruleStrong, lineWidth: 1))
    }

    // MARK: preview

    @ViewBuilder private func preview(_ p: ViewPreview) -> some View {
        heading(p.title, from: nil)
        Text("Nothing is sent yet. This is exactly what will go.").font(Theme.subtitle).foregroundColor(Theme.stone)
        ForEach(Array(p.words.enumerated()), id: \.offset) { _, w in
            VStack(alignment: .leading, spacing: 3) {
                Text(w.label).font(Theme.label).foregroundColor(Theme.ash)
                Text(w.value).font(Theme.title).foregroundColor(DeepGlass.ink).textSelection(.enabled)
            }
            .padding(10).frame(maxWidth: .infinity, alignment: .leading).background(box)
        }
        Text("Return sends it \u{00B7} Esc goes back").font(Theme.subtitle).foregroundColor(Theme.ash)
    }
}
