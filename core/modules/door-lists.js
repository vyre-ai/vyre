// @ts-check
// core/modules/door-lists.js: which tools a Space MEMBER's own session may call. Data only; the gate is core/modules/door-gate.js.
// Four lists, and every tool the registry holds is on exactly one of them (door-gate.test.js fails otherwise, so a new tool must be placed on purpose):
//   MEMBER_MAY: a member may call it; the handler or the kernel judges her on her own chain.
//   OWNER_ONLY: refused to a member (the owner and admins are served). The default for anything whose handler does not yet keep a member to her own.
// Note: files.drive.space.list is on MEMBER_MAY because the MODULE refuses a member on her own chain (core/files/space-drive.js: the kernel's drive.read grant decides; she gets not_found), not because the gate does.
//   SELF_GATED: the vault's tools: the vault's own member gate (core/vault/member-gate.js) refuses a member in its own words, so this gate passes them on and leaves them off her list.
//   PLUMBING:   the harness hooks; never gated.
// Source of the placing: team/0.3.4/DOOR-INVENTORY.md. Moving a tool to MEMBER_MAY needs a test that calls it as a member.

/** Tools a member's own session may call: the handler judges her on her own chain (or the kernel does), so the answer is what she may see and change, not the owner's. A device that is not yet proven reaches the sign-in and pairing steps here (presence.person.*, wink.server.adopt and pair.answer, wink.phone.*): it must reach them to become proven, and each carries its own proof (passkey, code, ticket). */
export const MEMBER_MAY = Object.freeze(new Set([
  "agents.create", "agents.delete", "agents.history", "agents.list", "agents.threads", "agents.update", "agents.usage", "agents.versions",
  // An agent's files, context, links, Vault list and sharing: anyone calls them; the handler judges her as the agent's creator, an admin, or someone given Can edit (Can use sees where it is used), and every link against what she herself can reach.
  "agents.access.get", "agents.access.set", "agents.ask", "agents.context.add", "agents.context.link", "agents.context.list", "agents.context.remove", "agents.context.unlink", "agents.docs.get", "agents.docs.set", "agents.used",
  "agents.vault.assign", "agents.vault.list", "agents.vault.unassign",
  "appmods.card", "appmods.catalog", "appmods.list", "appmods.screens", "appmods.status",
  "files.drive.address", "files.drive.space.list", "files.drive.space.read", "files.drive.unshare", "files.drive.versions",
  "flows.access.get", "flows.access.set", "flows.cancel", "flows.card", "flows.cheatsheet", "flows.code", "flows.compile-text", "flows.control", "flows.define", "flows.diff", "flows.from-chat", "flows.get",
  "flows.graph", "flows.health", "flows.kit.card", "flows.kit.diff", "flows.kit.library", "flows.kit.library.get", "flows.kit.list", "flows.kit.propose", "flows.kit.test",
  "flows.list", "flows.patch", "flows.propose", "flows.retry", "flows.simulate", "flows.start", "flows.test.list", "flows.test.run", "flows.test.save", "flows.timeline",
  "goals.get", "goals.list", "goals.milestone-done", "goals.set",
  "memory.answer", "memory.ask", "memory.brief", "memory.card", "memory.context", "memory.decisions", "memory.facts", "memory.graph", "memory.prompt", "memory.relevant",
  "memory.retrieve", "memory.space.recall", "memory.stats", "memory.today", "memory.why",
  "mentions.kinds",
  "models.get", "models.list", "models.status",
  "planner.add", "planner.bin", "planner.list", "planner.parse", "planner.ringing", "planner.upcoming",
  "presence.person.pair-challenge", "presence.person.start", "presence.person.start-paired", "presence.person.status",
  "previews.get", "previews.list", "previews.share",
  "projects.list",
  "providers.list",
  "records.actors", "records.create", "records.events", "records.forget.propose", "records.get", "records.holders", "records.kits.get", "records.kits.library",
  "records.linked", "records.list", "records.me", "records.reference", "records.roles", "records.seal-put", "records.types", "records.update",
  "roles.catalogue", "roles.get", "roles.list", "roles.tools",
  "rules.get", "rules.list", "rules.test",
  "runner.move",
  "sessions.accounts.add", "sessions.accounts.bind", "sessions.accounts.list", "sessions.accounts.signin",
  "skills.draft", "skills.find", "skills.get", "skills.list",
  "spaces.list", "spaces.members.list",
  "stream.catchup", "stream.keep", "stream.mark-read", "stream.open", "stream.pin", "stream.react", "stream.read", "stream.reply-mode", "stream.second-opinion",
  "stream.send", "stream.typing",
  "tasks.get", "tasks.list", "tasks.move", "tasks.request", "tasks.submit",
  "team.ask", "team.notes",
  "threads.archive", "threads.asks", "threads.chat-stop", "threads.commands", "threads.delete", "threads.edit", "threads.edit-retry", "threads.effort", "threads.get",
  "threads.interrupt", "threads.items", "threads.kill-task", "threads.list", "threads.model", "threads.queue", "threads.rename", "threads.retry", "threads.rewind",
  "threads.send", "threads.send-now", "threads.stop", "threads.switch", "threads.tasks", "threads.thinking", "threads.unarchive", "threads.unqueue", "threads.unwatch",
  "threads.watch",
  "views.list",
  "wink.phone.pair.answer", "wink.phone.pairing", "wink.phone.wait", "wink.server.adopt", "wink.server.pair.answer",
  "work.chat.change", "work.chat.create", "work.chat.get", "work.chat.link", "work.chat.list", "work.chat.move", "work.chat.persistent", "work.chat.pin",
  "work.chat.rename", "work.chat.span", "work.chat.upgrade-plan", "work.file.list", "work.file.share", "work.file.unshare", "work.know.answer", "work.know.search",
  "work.know.suggestions", "work.link.suggest", "work.project.level", "work.situation", "work.start-project", "work.team.context", "work.team.doing", "work.template.library", "work.timeline",
]));

/** Tools only the Space's owner and admins call from a session: the owner's connected accounts, computers, services, spend, settings and set-up, and every tool whose handler does not yet keep a member to her own. */
export const OWNER_ONLY = Object.freeze(new Set([
  "about.text",
  "agents.resume", "agents.rollover", "agents.spawn", "agents.stop",
  "appearance.check", "appearance.presets", "appearance.resolve",
  "appmods.connection", "appmods.domain.add", "appmods.domain.list", "appmods.domain.remove", "appmods.hosts", "appmods.install", "appmods.logs", "appmods.open",
  "appmods.remove", "appmods.start", "appmods.stop",
  "approvals.answer", "approvals.answer-group", "approvals.ask", "approvals.edit-item", "approvals.item-view", "approvals.items", "approvals.local-yes",
  "approvals.pending", "approvals.request", "approvals.status",
  "artifacts.activity", "artifacts.activity.log", "artifacts.archive", "artifacts.create", "artifacts.delete", "artifacts.diff", "artifacts.export", "artifacts.get",
  "artifacts.list", "artifacts.media.copy", "artifacts.media.gallery", "artifacts.media.read", "artifacts.media.usage", "artifacts.mention.search", "artifacts.move",
  "artifacts.public.set", "artifacts.public.status", "artifacts.restore", "artifacts.search", "artifacts.share", "artifacts.undelete", "artifacts.unshare",
  "artifacts.update", "artifacts.versions",
  "ask.answer", "ask.cancel", "ask.get", "ask.many",
  "assistant.access.get", "assistant.access.narrow", "assistant.access.restore", "assistant.brief", "assistant.capabilities", "assistant.daily", "assistant.glance",
  "assistant.log", "assistant.patterns", "assistant.prompt.diff", "assistant.welcome",
  "attachments.get", "attachments.list", "attachments.put",
  "brand.draft", "brand.get", "brand.resolve", "brand.set",
  "bridges.accept", "bridges.continue", "bridges.copy", "bridges.get", "bridges.kit.export", "bridges.kit.install", "bridges.kit.plan", "bridges.list",
  "bridges.merge.links", "bridges.propose-projection", "bridges.propose-reference", "bridges.propose-view", "bridges.resolve", "bridges.revoke", "bridges.view.read",
  "chrome.click", "chrome.open", "chrome.screenshot", "chrome.snapshot", "chrome.type",
  "commands.list",
  "comms.send",
  "computer.targets", "computer.use",
  "computers.checkout", "computers.egress.set", "computers.egress.status", "computers.get", "computers.giveback", "computers.handback.set", "computers.handback.status",
  "computers.limits", "computers.list", "computers.member.add", "computers.member.dispose", "computers.member.remove", "computers.member.rotate", "computers.pause",
  "computers.release", "computers.rename", "computers.restart", "computers.resume", "computers.stop", "computers.tailnet.set", "computers.tailnet.status",
  "computers.takeover", "computers.watch",
  "connectors.calendar.today", "connectors.catalog", "connectors.connect", "connectors.connect.cancel", "connectors.connect.finish", "connectors.connection.approve",
  "connectors.connection.check", "connectors.connection.create", "connectors.connection.decline", "connectors.connection.delete", "connectors.connection.export",
  "connectors.connection.get", "connectors.connection.import", "connectors.connection.list", "connectors.connection.proposals", "connectors.connection.propose",
  "connectors.connection.rebuild", "connectors.connection.update", "connectors.declare", "connectors.declared", "connectors.disconnect", "connectors.list",
  "connectors.logging", "connectors.mention.search", "connectors.operation.run", "connectors.scope", "connectors.site.attention", "connectors.site.connect",
  "connectors.site.limits", "connectors.site.limits.set", "connectors.site.list", "connectors.site.operations", "connectors.site.propose", "connectors.site.resume",
  "connectors.site.rollback", "connectors.site.rows", "connectors.site.sync",
  "context.now", "context.report",
  "design.catalogue", "design.css", "design.css.propose", "design.css.status", "design.css.verify", "design.decide", "design.proposals", "design.propose",
  "design.screen.remove", "design.screens", "design.validate",
  "docs.find", "docs.read",
  "documents.generate", "documents.send", "documents.send-signed", "documents.signed-link", "documents.signed-link.revoke", "documents.signing.flow",
  "documents.signing.remind", "documents.signing.waiting", "documents.template.add", "documents.template.get", "documents.template.list",
  "events.catalog",
  "files.deliver", "files.dirs", "files.drive.access", "files.drive.audit", "files.drive.candidates", "files.drive.link.create", "files.drive.link.list",
  "files.drive.link.revoke", "files.drive.list", "files.drive.measure", "files.drive.offer", "files.drive.read", "files.drive.restore", "files.drive.search",
  "files.drive.share", "files.drive.status", "files.drive.upload", "files.drop.ack", "files.drop.begin", "files.drop.cancel", "files.drop.finish", "files.drop.get",
  "files.drop.meta", "files.drop.pending", "files.drop.put", "files.drop.register", "files.drop.targets", "files.drop.unregister", "files.fetch", "files.mentions.search",
  "files.preview", "files.recent", "files.search", "files.stat",
  "flows.advance", "flows.approve", "flows.attention", "flows.budget", "flows.connections", "flows.describe", "flows.kit.remove", "flows.pause", "flows.resume",
  "flows.rollback", "flows.run", "flows.runs", "flows.settle", "flows.test.remove",
  "gate.approve", "gate.get", "gate.held", "gate.reject", "gate.request", "gate.revise", "gate.said.add", "gate.said.list", "gate.said.revoke", "gate.senders",
  "gate.settle",
  "github.accounts", "github.connect", "github.connect.cancel", "github.mcp.sync", "github.mentions.resolve", "github.mentions.search", "github.owners", "github.project",
  "github.project.add-repo", "github.project.detect", "github.project.issue.get", "github.project.issue.list", "github.project.local-init", "github.project.of",
  "github.project.pr.comments", "github.project.pr.get", "github.project.pr.merge", "github.project.pr.open", "github.project.pr.review", "github.project.pr.status",
  "github.remove", "github.repo.create", "github.repos", "github.session.history", "github.session.push", "github.session.redo", "github.session.undo", "github.star",
  "github.star.status",
  "glass.close", "glass.files.download", "glass.files.list", "glass.files.mkdir", "glass.files.move", "glass.files.preview", "glass.files.stat", "glass.files.trash",
  "glass.files.upload", "glass.open", "glass.release", "glass.take", "glass.targets",
  "goals.accept",
  "google.accounts", "google.add", "google.calendar.create", "google.calendar.list", "google.calendar.next", "google.calendar.search", "google.calendar.today",
  "google.calendar.update", "google.connect", "google.connect.cancel", "google.connect.finish", "google.find", "google.mail.draft", "google.mail.read",
  "google.mail.search", "google.mail.send", "google.open", "google.remove", "google.test",
  "hands-desktop.act", "hands-desktop.apps", "hands-desktop.screenshot", "hands-desktop.tree",
  "hooks.close", "hooks.delivery", "hooks.enable", "hooks.list", "hooks.open", "hooks.status",
  "import.cancel", "import.plan", "import.scan", "import.start", "import.status", "import.stop",
  "learn.accept", "learn.add", "learn.check", "learn.edit", "learn.lessons", "learn.relax", "learn.retire", "learn.signals", "learn.skill-dismiss", "learn.skill-install",
  "learn.skill-retire", "learn.skills", "learn.stats",
  "link.companion.approve", "link.companion.hello", "link.companion.list", "link.companion.pair", "link.companion.remove", "link.events", "link.health", "link.hello",
  "link.macs", "link.pair.approve", "link.pair.deny", "link.pair.poll", "link.pair.request", "link.peers", "link.pending", "link.rename", "link.reply", "link.serve",
  "link.status", "link.unpair",
  "mail.accounts", "mail.compose", "mail.find", "mail.map", "mail.read", "mail.search", "mail.send", "mail.test",
  "mcp.add", "mcp.call", "mcp.remove", "mcp.restart", "mcp.servers", "mcp.test", "mcp.tools", "mcp.update",
  "memory.backup.restore", "memory.backup.run", "memory.backup.status", "memory.contradictions", "memory.correct", "memory.corrections", "memory.curate", "memory.device",
  "memory.follow", "memory.heard", "memory.identity.enroll", "memory.identity.grant", "memory.identity.lock", "memory.identity.move", "memory.identity.revoke",
  "memory.identity.status", "memory.identity.unlock.begin", "memory.identity.unlock.finish", "memory.markers", "memory.me", "memory.merge", "memory.mute",
  "memory.personal.set-cap", "memory.personal.status", "memory.pin", "memory.profile", "memory.read", "memory.remember", "memory.sealscan", "memory.settle",
  "memory.site.detail", "memory.site.forget", "memory.site.get", "memory.site.list", "memory.site.put", "memory.site.report", "memory.site.restore", "memory.site.rollback",
  "memory.site.sync", "memory.space.file", "memory.space.retire", "memory.split", "memory.suggest", "memory.uncorrect", "memory.write", "memory.write.forget",
  "memory.write.restore", "memory.writes",
  "mentions.search",
  "models.eval-approve", "models.eval-decline", "models.eval-queue", "models.eval-record", "models.evals", "models.refresh",
  "modules.list.reset", "modules.list.reset.answer", "modules.list.reset.ask", "modules.list.reset.pending", "modules.list.reset.status",
  "names.check", "names.domain.check", "names.serve", "names.status", "names.unserve",
  "network.wink.join", "network.wink.leave", "network.wink.status", "network.wink.whois",
  "onboard.assistant", "onboard.claude", "onboard.finish", "onboard.history", "onboard.join", "onboard.link", "onboard.machine", "onboard.name", "onboard.pair",
  "onboard.passkey", "onboard.setup", "onboard.skip", "onboard.status", "onboard.you",
  "outside.grant", "outside.list", "outside.register", "outside.revoke", "outside.token", "outside.ungrant",
  "planner.agenda", "planner.calendar.create", "planner.calendar.sync", "planner.delete", "planner.dismiss", "planner.done", "planner.get", "planner.settings",
  "planner.snooze", "planner.update",
  "pluginagent.ask", "pluginagent.decline", "pluginagent.grant", "pluginagent.on", "pluginagent.pending", "pluginagent.revoke", "pluginagent.status",
  "presence.capsule.pin", "presence.code", "presence.enroll", "presence.keys", "presence.person.locked", "presence.person.renew-allow", "presence.person.revoke", "presence.person.rotate",
  "presence.person.sessions", "presence.remove",
  "previews.frame", "previews.keep", "previews.log", "previews.open", "previews.operator", "previews.remove", "previews.reply", "previews.restart", "previews.run-get",
  "previews.signin", "previews.signin-done", "previews.signin-get", "previews.step", "previews.stop", "previews.thumb", "previews.url",
  "projects.access.check", "projects.access.grant", "projects.access.list", "projects.access.pending", "projects.access.restore", "projects.access.revoke",
  "projects.sync", "projects.add-threads", "projects.add-workspace", "projects.archive", "projects.catalog", "projects.context", "projects.create", "projects.history", "projects.of",
  "projects.remove-threads", "projects.rename", "projects.threads", "projects.watchers.add", "projects.watchers.remove",
  "roles.assign", "roles.create", "roles.remove", "roles.update",
  "publish.approve", "publish.create", "publish.decide", "publish.domain.add", "publish.domain.remove", "publish.domain.verify", "publish.edge", "publish.edge.down",
  "publish.edge.up", "publish.flow", "publish.go", "publish.job.attention", "publish.job.run", "publish.job.runs", "publish.list", "publish.plan", "publish.preview",
  "publish.publish", "publish.quick", "publish.retire", "publish.rollback", "publish.secret.grant", "publish.secret.revoke", "publish.status",
  "push.devices", "push.key", "push.receipt", "push.seen", "push.settings", "push.subscribe", "push.test", "push.unsubscribe",
  "recall.eval", "recall.index", "recall.links", "recall.pointers", "recall.related", "recall.sealscan", "recall.sealscrub", "recall.search", "recall.sessions",
  "recall.setup", "recall.status", "recall.thread", "recall.transcript", "recall.turn", "recall.unwatch", "recall.watch",
  "records.define", "records.dev-seed", "records.forget", "records.reveal", "records.sees-as",
  "relay.devices.ask-trust", "relay.devices.list", "relay.devices.mark", "relay.devices.path", "relay.devices.remove", "relay.devices.rename", "relay.devices.trust",
  "relay.disable", "relay.enable", "relay.join", "relay.pair.first", "relay.pair.start", "relay.pair.ticket", "relay.pair.window.close", "relay.pair.window.confirm",
  "relay.pair.window.open", "relay.pair.window.ping", "relay.pair.window.reject", "relay.pair.window.renew", "relay.setup.status", "relay.status", "relay.web.pin",
  "relay.web.release",
  "releases.cert", "releases.sign",
  "rules.accept", "rules.define", "rules.disable", "rules.dismiss", "rules.enable", "rules.propose", "rules.remove",
  "runner.folders", "runner.folders.allow", "runner.folders.available", "runner.folders.remove", "runner.here", "runner.lock", "runner.pause-all", "runner.place",
  "runner.placement", "runner.places", "runner.preview", "runner.resume-all", "runner.settings", "runner.settings.set", "runner.start", "runner.status", "runner.stop",
  "runner.why-not",
  "sessions.accounts.key", "sessions.accounts.remove", "sessions.accounts.set", "sessions.harness.get", "sessions.limits.get", "sessions.limits.set",
  "sessions.mention.search", "sessions.mode.get", "sessions.mode.set", "sessions.models", "sessions.models.get", "sessions.models.set", "sessions.prompt.get",
  "sessions.prompt.history", "sessions.prompt.preview", "sessions.prompt.revert", "sessions.prompt.set", "sessions.routes.get", "sessions.routes.set", "sessions.setup",
  "sessions.slots.status", "sessions.status", "sessions.usage.get", "sessions.usage.resume",
  "settings.changes", "settings.get", "settings.request", "settings.reset", "settings.schema", "settings.set", "settings.snapshot", "settings.undo",
  "sidebar.edit", "sidebar.get", "sidebar.pin", "sidebar.stored", "sidebar.team", "sidebar.unpin",
  "sight.frame", "sight.now", "sight.steps", "sight.targets", "sight.watch",
  "signin.answer", "signin.ask", "signin.dev", "signin.end", "signin.pending", "signin.status",
  "skills.approve", "skills.rollback", "skills.versions",
  "spaces.assess-computer", "spaces.bundle.enrol", "spaces.bundle.export", "spaces.bundle.status", "spaces.cancel", "spaces.code.submit", "spaces.compute.accept",
  "spaces.compute.allow", "spaces.compute.status", "spaces.create", "spaces.devices.enrol", "spaces.devices.lend", "spaces.devices.lend.status", "spaces.devices.list",
  "spaces.devices.remove", "spaces.devices.restore", "spaces.devices.set", "spaces.devices.spaces", "spaces.get", "spaces.host-here", "spaces.identity.alias",
  "spaces.identity.alias.add", "spaces.identity.code.replace", "spaces.identity.contact.key", "spaces.identity.create", "spaces.identity.devices",
  "spaces.identity.entries", "spaces.identity.entry.add", "spaces.identity.entry.remove", "spaces.identity.recover.approve", "spaces.identity.recover.begin",
  "spaces.identity.recover.code", "spaces.identity.recover.finish", "spaces.identity.republish", "spaces.identity.resolve", "spaces.identity.status",
  "spaces.identity.sync", "spaces.invites.accept", "spaces.invites.confirm", "spaces.invites.create", "spaces.invites.list", "spaces.invites.preview",
  "spaces.invites.redeem", "spaces.invites.revoke", "spaces.members.add", "spaces.members.add-agent", "spaces.members.computers", "spaces.members.extend",
  "spaces.members.remove", "spaces.members.set-role", "spaces.members.transfer", "spaces.move.plan", "spaces.moves.evidence", "spaces.moves.finish", "spaces.moves.receipt",
  "spaces.moves.receive", "spaces.name-here", "spaces.personal-host.set", "spaces.presence.begin", "spaces.presence.recover", "spaces.presence.sync",
  "spaces.records.status", "spaces.resume", "spaces.retire-here", "spaces.roles.names", "spaces.server.install", "spaces.servers", "spaces.setup.claim",
  "spaces.setup.save", "spaces.status", "spaces.storage.delete", "spaces.storage.get", "spaces.storage.list", "spaces.storage.put", "spaces.storage.put-if",
  "spaces.storage.set-cap", "spaces.storage.usage", "spaces.time-zone.set", "spaces.upgrade.plan", "spaces.upgrade.receipt", "spaces.upgrade.run",
  "spaces.upgrade.wrap-key",
  "spend.check", "spend.raise", "spend.summary",
  "statusline.line",
  "stream.open-peer",
  "suggest.picked", "suggest.query",
  "sync.consent", "sync.delete", "sync.delete.import", "sync.upload.cancel", "sync.upload.chunk", "sync.upload.finish", "sync.upload.plan", "sync.upload.start",
  "system.build", "system.echo", "system.info", "system.modules", "system.rename",
  "tasks.decide",
  "team.add", "team.cancel", "team.charter.accept", "team.charter.diff", "team.charter.draft", "team.charter.get", "team.charter.history", "team.charter.revert",
  "team.charter.set", "team.default.get", "team.default.set", "team.done", "team.duties.create", "team.duties.delete", "team.duties.disable", "team.duties.enable",
  "team.duties.list", "team.duties.run-now", "team.duties.start", "team.duties.update", "team.fail", "team.list", "team.merge", "team.project-append",
  "team.project-has-any", "team.retire", "team.role.fill", "team.status",
  "term.attach", "term.close", "term.list", "term.open",
  "threads.answer", "threads.branch", "threads.chat-of", "threads.chat-switch", "threads.continue-here", "threads.fork", "threads.lease", "threads.mode", "threads.of-chat",
  "threads.release", "threads.remember", "threads.roll", "threads.roll-session", "threads.rolls", "threads.shell", "threads.start", "threads.undo-edit",
  "tips.dismiss", "tips.list", "tips.next", "tips.reset", "tips.seen", "tips.used", "tips.whatsnew",
  "undo.list", "undo.run",
  "update.apply", "update.check", "update.status", "update.whats-new", "update.whats-new-seen",
  "views.act", "views.get", "views.preview", "views.show", "views.shown",
  "vitals.advice", "vitals.explain", "vitals.status", "vitals.summary", "vitals.watch",
  "vyre.core",
  "waiting.count", "waiting.list",
  "watchers.card", "watchers.create", "watchers.delete", "watchers.items", "watchers.list", "watchers.logs", "watchers.pause", "watchers.preset", "watchers.resume",
  "watchers.run", "watchers.test",
  "wink.access", "wink.approve", "wink.cancel", "wink.card", "wink.code.ack", "wink.code.open", "wink.code.redeem", "wink.code.status", "wink.decline", "wink.device.key",
  "wink.invite", "wink.offer.set", "wink.offers", "wink.pair.server", "wink.pair.status", "wink.pair.targets", "wink.phone.enrolled", "wink.phone.open", "wink.phone.scan",
  "wink.relay.apply", "wink.remove", "wink.server.code", "wink.server.confirm", "wink.server.pairing", "wink.server.probe", "wink.server.release",
  "wink.server.reset.begin", "wink.server.reset.confirm", "wink.server.retarget", "wink.server.setup-offer", "wink.server.status", "wink.share", "wink.storage.bridge",
  "wink.storage.bridge.accept", "wink.storage.bridge.drive", "wink.storage.card", "wink.storage.discover", "wink.storage.offers", "wink.storage.pair", "wink.storage.pick",
  "wink.storage.remove", "wink.storage.status",
  "work.call", "work.chat.history-import", "work.chat.keys.begin", "work.chat.keys.finish", "work.chat.keys.lock", "work.chat.keys.status", "work.chat.upgrade-move",
  "work.know.accept", "work.project.create", "work.project.members", "work.project.move", "work.project.move-plan", "work.project.ref", "work.project.rename",
  "work.team.add", "work.template.define", "work.template.from-project", "work.template.get", "work.template.golive", "work.template.install", "work.template.list",
  "work.template.test", "work.tools",
]));

/** The vault's tools: gated by the vault itself (core/vault/member-gate.js), which refuses a member in its own words. */
export const SELF_GATED = Object.freeze(new Set([
  "vault.account.create", "vault.account.enroll-touchid", "vault.account.lock", "vault.account.status", "vault.account.unlock", "vault.account.unlock-phone",
  "vault.agent.fill", "vault.agent.grant", "vault.agent.grants", "vault.agent.revoke", "vault.approve", "vault.audit", "vault.autobackup.drill", "vault.autobackup.enrol",
  "vault.autobackup.run", "vault.autobackup.status", "vault.backup", "vault.breach.check", "vault.caps", "vault.clipboard.clear", "vault.codes", "vault.codes.import",
  "vault.connect", "vault.connections.grant", "vault.connections.list", "vault.connections.revoke", "vault.connections.sync", "vault.connections.update", "vault.copy",
  "vault.delete", "vault.device.approve", "vault.device.code", "vault.device.join", "vault.device.list", "vault.device.revoke", "vault.device.sync", "vault.device.unlock",
  "vault.devices", "vault.edit", "vault.emergency.add", "vault.emergency.deny", "vault.emergency.list", "vault.emergency.refresh", "vault.emergency.remove",
  "vault.emergency.request", "vault.emergency.status", "vault.env.scan", "vault.fill.native", "vault.fingerprint", "vault.generate", "vault.git", "vault.grant",
  "vault.grants.status", "vault.health", "vault.health.dismiss", "vault.health.summary", "vault.history", "vault.identity", "vault.import", "vault.import.preview",
  "vault.inject", "vault.item", "vault.items.names", "vault.kit", "vault.link", "vault.links", "vault.list", "vault.lock", "vault.match", "vault.mcp.items",
  "vault.mcp.pass.create", "vault.mcp.pass.list", "vault.mcp.pass.revoke", "vault.mcp.reveal.allow", "vault.mcp.reveal.clear", "vault.members.accept",
  "vault.members.invite", "vault.members.remove", "vault.members.role", "vault.mention.search", "vault.migrate-key", "vault.move", "vault.need", "vault.offboard",
  "vault.pass.accept", "vault.pass.create", "vault.pass.list", "vault.pass.revoke", "vault.pending", "vault.people", "vault.people.verify", "vault.person.add",
  "vault.provider.remove", "vault.provider.set", "vault.provider.status", "vault.put", "vault.relay", "vault.remind.run", "vault.render", "vault.request", "vault.resolve",
  "vault.restore", "vault.reveal", "vault.revert", "vault.revoke", "vault.rotate", "vault.rotation", "vault.search", "vault.session.close", "vault.session.open",
  "vault.session.status", "vault.ssh.add", "vault.ssh.approvals", "vault.ssh.approve", "vault.ssh.forget", "vault.ssh.generate", "vault.ssh.keys", "vault.state",
  "vault.sweep", "vault.tagged", "vault.totp", "vault.unlink", "vault.unlock", "vault.unlock-passphrase", "vault.untag", "vault.update", "vault.used-by", "vault.uses",
  "vault.vaults.create", "vault.vaults.list", "vault.vaults.rotate", "vault.vaults.sync",
]));

/** The hooks the session's own harness calls (harness.\*, and threads.bind, the SessionStart bind), not the model: never gated, so a member's session starts and its hooks run. */
export const PLUMBING = Object.freeze(new Set([
  "harness.brief", "harness.end", "harness.enrich", "harness.learn", "harness.rules", "harness.stop", "harness.touched",
  "threads.bind",
]));

/**
 * The outward tools (the registry's `outward` flag, the one test/outward-flags reads) that stay on MEMBER_MAY, each with whose yes a member's action waits for and why that is right for a member. A member's session that reaches an outward
 * tool lands a held card in the OWNER's approvals worded as her assistant's request (measured on mail.send and files.drive.upload), so an outward tool is not on MEMBER_MAY by its name: it is here, with a reason, or it is owner-only.
 * Empty today. The drift test fails for an outward tool on MEMBER_MAY that is not a key here, and for a key here that is not an outward tool on MEMBER_MAY.
 * @type {Readonly<Record<string, string>>}
 */
export const MEMBER_OUTWARD = Object.freeze({});

export const MEMBER_MAY_COUNT = MEMBER_MAY.size;

/**
 * The tool groups a role can switch on (core/roles/catalogue.js TOOL_IDS: mail, calendar, documents, files, publish, computers, browser). A group is a list of tool names, and every tool in one is on OWNER_ONLY:
 * a Member does not have it, and a custom role that turns the group on gives its holders exactly these tools and nothing else. Only the tools a person USES are in a group; the set-up, admin and
 * approval tools of the same areas (accounts and connections, domains, edge, secrets, limits, a member's computer, the owner's yes on a publish) stay the owner's and an admin's whatever a role says.
 * Left out on purpose until each is scoped to the person: the planner's event tools (agenda, get, update, delete, done, snooze, dismiss, calendar.*), which show any person's events.
 */
export const TOOL_GROUPS = Object.freeze({
  mail: Object.freeze(["mail.accounts", "mail.compose", "mail.find", "mail.map", "mail.read", "mail.search", "mail.send", "google.mail.draft", "google.mail.read", "google.mail.search", "google.mail.send"]),
  calendar: Object.freeze(["google.calendar.create", "google.calendar.list", "google.calendar.next", "google.calendar.search", "google.calendar.today", "google.calendar.update", "connectors.calendar.today"]),
  documents: Object.freeze(["documents.generate", "documents.send", "documents.send-signed", "documents.signed-link", "documents.signed-link.revoke", "documents.signing.flow", "documents.signing.remind",
    "documents.signing.waiting", "documents.template.add", "documents.template.get", "documents.template.list"]),
  files: Object.freeze(["files.deliver", "files.dirs", "files.drive.link.create", "files.drive.link.list", "files.drive.link.revoke", "files.drive.list", "files.drive.read", "files.drive.search", "files.drive.share",
    "files.drive.status", "files.drive.upload", "files.fetch", "files.mentions.search", "files.preview", "files.recent", "files.search", "files.stat"]),
  publish: Object.freeze(["publish.create", "publish.flow", "publish.go", "publish.list", "publish.plan", "publish.preview", "publish.publish", "publish.quick", "publish.status"]),
  computers: Object.freeze(["computer.targets", "computers.checkout", "computers.get", "computers.giveback", "computers.list", "computers.release", "computers.watch"]),
  browser: Object.freeze(["chrome.click", "chrome.open", "chrome.screenshot", "chrome.snapshot", "chrome.type", "glass.close", "glass.open", "glass.release", "glass.take", "glass.targets",
    "hands-desktop.act", "hands-desktop.apps", "hands-desktop.screenshot", "hands-desktop.tree"]),
});

/**
 * The groups a role can really turn on today: none. A group not here is accepted by the role record but ignored at the door, because its handlers do not yet keep a member to her own account or project:
 * mail and calendar use the Space's connected Gmail and Google (the owner's), computers and browser drive a computer and browser signed in as the owner, and documents, files and publish act in the Space's
 * drive and as the Space (only files.drive.space.* and the member door's project files are scoped to her, and they are already on her list). A group moves here when its handlers use the caller's own account or
 * project and a test as a member proves it. (The daemon takes a test seam, `doorScopedGroups`, to prove the role path itself.)
 */
export const SCOPED_GROUPS = Object.freeze(/** @type {string[]} */ ([]));

/** The group a tool belongs to, or undefined. */
export const GROUP_OF = Object.freeze(new Map(Object.entries(TOOL_GROUPS).flatMap(([group, tools]) => tools.map(t => /** @type {[string, string]} */ ([t, group])))));

/**
 * What a Guest (kernel role `temp`: a contractor or helper) may call: a smaller list than a Member's, only what is shared with them. Every entry is on MEMBER_MAY (a test checks it), where the handler or the
 * kernel judges her on her own chain. The sign-in and pairing steps are here, or a Guest could never sign in.
 */
export const GUEST_MAY = Object.freeze(new Set([
  "presence.person.pair-challenge", "presence.person.start", "presence.person.start-paired", "presence.person.status",
  "wink.phone.pair.answer", "wink.phone.pairing", "wink.phone.wait", "wink.server.adopt", "wink.server.pair.answer",
  "records.get", "records.list", "records.me", "records.types",
  "roles.tools",
  "spaces.list",
  "stream.catchup", "stream.mark-read", "stream.open", "stream.react", "stream.read", "stream.send", "stream.typing",
  "tasks.get", "tasks.list", "tasks.submit",
  "threads.get", "threads.items", "threads.list",
  "work.chat.get", "work.chat.list", "work.file.list",
  "files.drive.space.list", "files.drive.space.read",
]));
