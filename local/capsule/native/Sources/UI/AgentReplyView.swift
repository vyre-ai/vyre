// AgentReply: what can be done with an answer once it is in: Copy, and Deeper (the same question
// to the deeper model) after a fast answer. Follow-up needs no button: typing under an answer
// makes "Follow up" the first row, so Enter continues the same thread.

import SwiftUI

struct AgentReplyActions: View {
    @ObservedObject var model: CapsuleModel

    var body: some View {
        if AgentReplyActions.shown(model) {
            HStack(spacing: 10) {
                Button { model.copyReply() } label: { Text("Copy") }.buttonStyle(AgentButton(primary: false))
                if model.canGoDeeper {
                    Button { model.deeper() } label: { Text("Deeper · sonnet") }.buttonStyle(AgentButton(primary: false))
                }
                Spacer()
                Text("type to follow up").font(Theme.label).foregroundColor(Theme.ash)
            }
            .padding(.horizontal, 16).padding(.top, 8)
        }
    }

    @MainActor static func shown(_ m: CapsuleModel) -> Bool { m.reply?.finished == true && !m.replyText.isEmpty }
    static let height: CGFloat = 38
}
