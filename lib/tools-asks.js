// @ts-check
// lib/tools-asks: everyday asks for every tool an agent may use, keyed by the name the tool is called with. tools_find indexes these beside the tool's own name and description
// (lib/tools-index.js), because people and agents do not say "unarchive" or "rewind": they say "bring back a chat I put away" or "go back a few messages". Each line is
// `name: ask; ask; ask`, in the words a person would use for the job, never the tool's own name. A new tool needs no line to be found (its name and description still count);
// it earns one when tools_find puts a neighbour first (test/tools-find-quality.test.js reports the coverage and the held-out score).

const TABLE = `
threads_start: start a new chat with a coding session; open a headless claude session in a folder; begin a conversation that keeps running
threads_send: send a follow-up message into a chat that is already running; type into a chat; say something more to a session
threads_list: list my chats; which chats are running; show my active conversations; recent sessions
threads_get: open one chat and see its latest events; look at a single conversation record
threads_asks: which chats are waiting for me to answer; questions and permission asks waiting on me; what is a session asking me
threads_watch: tell me when a chat finishes; ping me when the session is done or stuck; watch a conversation until it stops
threads_unwatch: stop watching a chat; cancel a ping about a session
threads_interrupt: stop what the chat is doing right now; press escape in a session; cancel the running turn but keep the chat
threads_switch: turn this chat over to a different ai provider; continue the conversation on another company's model or account
threads_queue: what messages are queued for a chat; words waiting to be handed to the session
threads_send-now: push the queued message in right away; interrupt the turn with my queued words
threads_rewind: go back a few messages in a chat; step back to an earlier message and continue from there
threads_model: which model is this chat using; change the model of a chat; use opus or sonnet in this conversation
threads_effort: change how hard the model thinks in a chat; set reasoning effort low or high
threads_commands: which slash commands can I type in this chat; commands a session offers
threads_tasks: what background jobs is the chat running; subagents and shell tasks of a session
threads_thinking: turn extended thinking on or off for a chat
threads_fork: copy this session to try a different approach; duplicate a chat; branch a conversation into a new one
threads_delete: delete a chat for good; remove a conversation and everything in it
threads_archive: put a chat away; archive a conversation; tidy up an old session
threads_rename: rename a chat; give a conversation a new title
threads_unarchive: bring back a chat I put away; restore an archived conversation
threads_stop: stop a chat completely; end a running session
threads_items: the messages of a chat as cards; read what was said in a conversation
agents_list: which agents exist; who is working right now; list the assistants
agents_ask: ask another agent something and wait for the reply; talk to an agent
agents_threads: the chats of one agent; sessions an agent has had
agents_usage: how many tokens did the agents use; what the agents cost; time and spend per agent
agents_history: past conversations with an agent; what I asked an agent before
appearance_check: check a theme value before saving it
appearance_presets: which themes are there; list the colour schemes
appearance_resolve: switch to dark mode; what look does this device use; which theme is in effect
vault_item: details of one saved login without its password; what hosts does this credential belong to
vault_ssh_keys: show my ssh public keys; list ssh keys and fingerprints
vault_ssh_generate: generate an ssh key for a server; make a new ssh keypair
vault_list: what logins and keys are stored; list my saved passwords by name; which credentials exist
vault_grant: let a module or watcher use a saved login; give a tool access to a credential
vault_revoke: take away access to a saved login; stop a module using a credential
vault_pending: has anyone asked for access I still have to approve; waiting vault requests
vault_sweep: look for leaked secrets in a folder, git history or shell history; scan files for passwords left lying around
vault_generate: make a new password; generate a strong passphrase for the router; create a random password
vault_import_preview: what would an import add; preview importing passwords before doing it
vault_import: load my old logins from a csv or password manager export; import passwords from 1password bitwarden or chrome; bring in a dotenv file
vault_identity: my public card to share vault items with someone; the card another person needs to trust me
vault_pass_create: share saved logins with another person; give a colleague a copy of some passwords
vault_grants_status: who has been given a copy of my passwords; are shared logins still covered
vault_pass_accept: accept a shared login sent by someone; take a pass ticket
vault_account_status: is my vault locked; do I have a vault password; is touch id unlock set up
vault_history: earlier versions of a saved login; when did a password change
vault_agent_grant: let an agent sign in to a website with one of my logins; allow the assistant to log in to a site
vault_agent_grants: which logins can agents use; agent sign-ins active pending or expired
vault_connections_list: which connections can this surface use; what services am I signed in to
vault_connections_revoke: take back access I gave an agent; remove a connection from a surface; revoke a service sign-in
vault_request: call a vendor api with a saved key without seeing it; make an http request with a stored credential
vault_person_add: trust another person's vyre card; pin a contact's card
vault_fingerprint: my fingerprint and safety words to compare with a person
vault_session_close: lock my vault session now; sign out of the vault on this surface
vault_search: look up an item in my saved logins by name or host; find a login for a site
vault_clipboard_clear: clear what the vault copied to the clipboard
vault_caps: what the vault allows this surface to do; can I reveal a password here
vault_rotation: change a credential that is too old; how do I rotate a key; renew an expired secret
appmods_catalog: which apps can I install; available app modules
appmods_card: what an app needs and may reach before installing it
appmods_list: which apps are installed on this server
appmods_status: is this installed app running
appmods_screens: screens that installed apps add
appmods_connection: the connection an installed app declares
appmods_hosts: host names the installed apps need
artifacts_create: write up a document for a client; make a report, page or small app; create a dashboard
artifacts_update: save a new version of a document; change the content of an artifact; edit a report
artifacts_get: open and read an artifact; show the content of a document
artifacts_list: list my documents; show recent artifacts; what have I made
artifacts_search: find the spreadsheet or document I made last month; search my documents by words
artifacts_versions: show every version a document has had; history of a report's changes
artifacts_diff: what changed between two drafts; compare two versions of a document
artifacts_restore: go back to the previous version of my report; roll a document back to an earlier draft
artifacts_move: move a document to another project; give an artifact a different home
artifacts_archive: put the old page into the archive; hide a document from the lists; archive a report
artifacts_delete: delete a document; throw away a report
artifacts_undelete: bring a deleted document back; recover a document I deleted
artifacts_export: download a copy of a report as a file or pdf; export a document as html or markdown
artifacts_unshare: stop sharing a page with the public; turn off a public link
artifacts_public_status: are public links on; can this box serve shared pages; how many pages are public
artifacts_activity: what has an interactive page done lately
artifacts_media_gallery: show the images, videos and sounds that were generated
artifacts_media_usage: how much generated media is kept; how many ai images are stored
artifacts_media_copy: keep a generated image or video in my own folder
assistant_glance: the morning glance; what is waiting, running and next today
assistant_capabilities: what can the assistant do on this install; which tools and connectors does it have
assistant_welcome: the first message after setup
assistant_log: everything the assistant did for me; what actions were taken on my behalf
assistant_prompt_diff: what changed in the assistant's prompt between two versions
assistant_brief: give me the morning summary; one paragraph on what is waiting and what the agents are doing
assistant_patterns: what has the assistant noticed about my habits; patterns memory found; conflicting facts between projects
bridges_view_read: read a shared view from another space
bridges_resolve: look up what a vyre link to another space points to
bridges_copy: give another space a copy of this record; copy a record into a different space
bridges_continue: hand work over to another space as a task; continue in a different space
commands_list: which commands can I run; list the commands modules offer; which slash commands exist
computers_list: every agent's computer and its state; which agents have a screen
computers_get: one agent's computer
computers_checkout: give an agent a screen and a computer to work on; start a machine for an agent
computers_release: let go of an agent's screen
computers_restart: restart an agent's computer
computers_limits: give the agent more memory or processor cores for its machine
computers_pause: stop the agent's computer from clicking and typing; pause an agent's hands
gate_request: send an email, post or payment as the user; delete something that cannot be undone; ask for approval to send
gate_senders: who is allowed to send things out for me; the ways something can go out and what each takes
mcp_servers: which mcp servers are connected; list the apps I connected to talk to other tools
mcp_tools: the tools of each connected mcp server
mcp_call: call a tool on a connected mcp server
connectors_catalog: which services can I hook up; every app vyre can connect
connectors_list: the connections I made; which apps are connected
connectors_connection_check: does my stripe connection still work; test whether a connection is healthy
connectors_connection_list: which connections exist and are they green
connectors_connection_get: one connection and its declaration
connectors_connection_propose: connect a new service with an api key; set up an integration for approval
connectors_connection_import: turn an openapi spec or postman collection into a connection
connectors_connection_export: share a connection as a template with another team
connectors_calendar_today: today's next meetings across all calendars
docs_find: how do I do something in vyre; which docs page explains this
docs_read: open a docs page
events_catalog: every event type the modules can emit
files_search: find a file by name or content on this computer; where is that document
files_stat: size and date of a file or folder
files_preview: look inside a file; show the start of a file
files_fetch: bring a file from the box to this mac; fetch a file from the other computer
files_drive_status: is file sharing with the mac on
files_drive_list: what is in a shared folder on the box
files_drive_read: read a chunk of a shared file
files_drive_candidates: what folders could I share with my mac
files_drive_measure: how big is this folder and can it be shared
files_drive_audit: check who the network policy lets into my shares
files_drive_search: search the box's shared files by name or content
files_dirs: list the folders inside a folder
flows_kit_library: ready made starter packs of automations; which kits ship with vyre
flows_kit_library_get: one starter pack from the library
flows_define: write an automation; set up a workflow that happens when an event arrives
flows_propose: ask an owner to approve an automation draft
flows_card: what an automation can do and what it needs before approval
flows_get: one stored automation version
flows_list: which automations exist; list the flows
flows_code: an automation as code to read and edit
flows_compile-text: check the text of an automation without saving it
flows_graph: draw an automation as a graph
flows_simulate: try out an automation without really running it; replay recent events through a flow
flows_start: run the automation now with an input; trigger a flow by hand
flows_runs: list the automations that ran lately; recent runs of a flow
flows_run: what did one automation run do; see the steps of one run
flows_budget: how much of the daily ai allowance for automations is used
flows_retry: try the failed run again; rerun a failed automation
flows_kit_card: what installing a starter pack involves
flows_kit_propose: install a starter pack of automations for approval
flows_kit_list: which kits are installed in this space
flows_kit_diff: what updating a kit would change
github_session_push: push my work to the remote repository; send the session's branch to github
github_project_pr_get: show a pull request
github_project_pr_status: did the tests pass on the pull request; is the pull request mergeable or merged
github_project_pr_comments: show the comments on a pull request; what did reviewers say
github_project_issue_list: which issues are open on the repository; list the issues of the project
github_project_issue_get: details of one issue with its labels and comments
github_project_pr_merge: merge the pull request; squash or rebase a pull request
github_project_pr_review: leave a review on the pull request; approve or request changes on a pull request
github_project_pr_open: open a new pull request for this branch
github_project_local-init: start tracking this folder with git so I can undo; set up undo without github
github_session_history: the commits a session made so far
github_session_undo: undo the last change the coding session made; take the session's commits back
github_session_redo: put back what the undo took off
glass_files_list: list a folder on the remote machine; what is in a folder on the other computer
glass_files_stat: info about one file on the remote machine
glass_files_preview: preview a file on the remote machine
glass_files_download: fetch a file from the remote machine; download from the shared computer
glass_files_upload: upload a file to the shared computer; put a file on the remote machine
glass_files_move: move or rename a file on the remote machine
glass_files_mkdir: make a new folder on the remote machine; create a directory on the other computer
glass_files_trash: throw an old file away on the remote machine; delete a file on the remote computer
goals_set: set a target for the quarter; define a goal with milestones
goals_milestone-done: mark the milestone finished; tick off a step of a goal
goals_get: show one goal
goals_list: what goals am I working towards; list my objectives
google_accounts: which google accounts are linked
google_calendar_next: what are my next events across all accounts; upcoming meetings
google_calendar_today: what is in my diary today; today's meetings
google_calendar_list: what is on my calendar between two dates; events in a time range
google_calendar_search: search my calendar for the board meeting; find an event by words
google_calendar_create: book lunch with someone on friday; add an appointment to my calendar; schedule an event
google_calendar_update: move the dentist event to another day; change or reschedule a meeting
google_mail_search: find the message from the landlord; search my gmail; which emails are unread
google_mail_read: read the latest email from my bank; open a gmail message or thread
google_mail_draft: draft a reply to my accountant but do not send it; save an email as a draft
google_mail_send: send the email I wrote; email someone as me
google_find: what's next today; email from a person; quick search of mail and calendar
hooks_list: what incoming webhooks are open
hooks_status: is the webhook listener reachable from the internet
learn_lessons: what lessons have been learned from past mistakes; the rules vyre learned from me
learn_add: record a lesson so it does not happen again; add a rule I want remembered
learn_edit: tighten a lesson; make a learned rule stricter
learn_stats: does a lesson work; how often are lessons broken
learn_skills: skills vyre drafted from things I repeat
link_health: is the connection to my phone healthy; how are things between the box and my phone, direct or relay
link_status: which macs are paired with this box; waiting pairing requests
mail_accounts: which mail accounts can I use
mail_search: search my inbox; which messages are unread; find an email from someone
mail_read: read an email; open a message
mail_send: send an email from my account
memory_graph: show me how the things I know are connected; draw the memory graph
memory_facts: what facts do you hold about this
memory_relevant: which known facts matter for this text
memory_why: why did you bring up that old note; what supports this fact; where did this come up
memory_pin: keep this note near the top of what you remember; always rank this fact first
memory_mute: stop bringing up a certain topic; never offer this memory again
memory_writes: what have agents written to memory lately; recent memory entries
memory_write_forget: forget something that was saved by mistake; remove a memory entry
memory_write_restore: undo a forget; bring back a forgotten memory
memory_answer: answer a question about my own life in one line
memory_space_retire: take a fact out of use in this space
memory_identity_status: is my identity memory sealed
memory_identity_unlock_begin: ask to read my sealed identity memory
memory_identity_lock: lock the identity memory now
memory_ask: what did we decide about this; answer a question about my past work; who said what
memory_decisions: what did I decide last time about hiring; the decisions made per project and topic
memory_suggest: complete a name memory knows
memory_profile: the lasting facts about me for a prompt
memory_remember: keep this fact for later; note down a decision; remember that I moved
memory_correct: fix a fact you remembered wrongly; that stored fact is incorrect, change it
memory_curate: rebuild the memory graph now
memory_context: lines of memory worth adding before a prompt
memory_today: what happened in the project this week
memory_brief: what a session is told about memory when it starts
memory_prompt: memory text blocks for a provider's prompt
memory_card: one card about a person, org or project
memory_stats: how much does memory hold
names_status: this box's name and whether it is held
names_check: can I use the name acme for my box; is this vyre.run name free
onboard_status: where am I in the setup steps; what is left to finish onboarding
onboard_setup: the list of setup steps in order
planner_add: remind me to do something at a time; add a to-do; set an alarm or timer
planner_list: what are my reminders; show my to-dos
planner_get: one reminder and when it rang
planner_ringing: which reminders are going off at the moment; what is ringing now
planner_update: change the time of a reminder; edit a to-do
planner_done: tick off a to-do; mark a reminder finished; stop an alarm
planner_snooze: snooze the alarm for ten minutes; remind me again later
planner_dismiss: stop a reminder without finishing it
planner_delete: delete a reminder I no longer need
planner_bin: bring back a reminder I deleted; recently deleted events
planner_agenda: what is on today; the agenda between two dates
planner_upcoming: when is my next reminder going to ring; reminders due in the next hours
planner_calendar_sync: put my reminders and google calendar together; pull calendar events into the planner
planner_calendar_create: make a calendar event
planner_parse: turn a spoken sentence like in two hours into a time; understand an alarm phrase
pluginagent_ask: claude code on this computer asks to read my memory
pluginagent_status: has claude code been given access to my memory
projects_list: what projects are there; show all projects
projects_history: keep a version history for a project folder
projects_of: which project does this folder belong to; what folders belong to this project
projects_threads: the chats of a project
projects_context: the brief for a chat starting in a project
sessions_status: how do sessions run on this machine
sessions_prompt_get: the system prompt set for the assistant, an agent or a project
sessions_prompt_history: earlier versions of a system prompt
sessions_prompt_preview: show the system prompt a new chat would start with
sessions_models: which models can a chat switch to
sessions_models_get: what model does each kind of session run on
sessions_routes_get: the fallback order of providers and accounts
sessions_accounts_list: which claude accounts are signed in; accounts on each provider
sessions_accounts_add: add an account for a provider
sessions_accounts_signin: sign an account in with the provider's login
sessions_accounts_bind: let another project or agent use an account
sessions_usage_get: how much of my claude plan have I used
sessions_slots_status: how many teammates are running at once; how many subagents are waiting
sessions_limits_get: the limit on running teammates and subagents
sessions_mode_get: the permission mode new sessions start in
providers_list: which ai providers are on this machine
publish_create: start a new website or app as a draft; make a new site
publish_preview: build a draft and see it at a private address; preview my website
publish_plan: what would change if I publish; what goes public
publish_approve: approve the preview of a site
publish_publish: put the site on the internet; make the website live; deploy the site
publish_rollback: roll the website back to the last good version; put the previous site version back
publish_status: how is my site doing; the stage and address of a site
publish_list: list my sites
publish_secret_grant: let a site use a saved secret
publish_flow: the publish pipeline as an automation
recall_search: search every past session by words; find an old chat
recall_thread: read one past session in order
recall_links: which turns touched a file
recall_sessions: list indexed sessions
recall_status: how much is indexed for search
relay_status: is the relay connected; how many devices are paired through it
runner_status: can this computer run a space's sessions
runner_place: where would a session in this space run
settings_schema: every setting that exists
settings_get: what is a setting's value and where does it come from
settings_snapshot: all settings in effect for one surface
settings_request: change a setting in vyre; use sonnet by default; reset a setting
settings_changes: recent settings changes
sidebar_get: the sidebar for a space
sidebar_edit: change my own sidebar; add or hide a place in my sidebar
sidebar_team: change the space's default sidebar
skills_list: what skills exist
skills_find: which skill fits this job
skills_get: read one skill's instructions
spend_check: may a provider spend now; am I under the cap
spend_summary: how much money have the models cost me so far; today's spend per provider
system_info: what version of vyre is running; what machine is this
system_echo: test that the tools work
team_add: add a new person to my team of agents; hire a teammate for a project
team_retire: retire a teammate
team_charter_get: a teammate's charter
team_charter_history: every version of a teammate's charter
team_charter_diff: what a charter version changed
team_charter_draft: write a teammate's charter
team_role_fill: have one of my agents fill a role on a project
team_duties_create: set up a task that repeats for a teammate; give a teammate a standing duty
team_duties_list: a teammate's standing duties
team_duties_update: change or pause a duty
team_duties_start: turn on a proposed duty
team_list: who is on the team of a project
team_ask: let a teammate know I need the logo redesigned; give work to the designer or backend person
team_status: what is the state of my request to a teammate; what is everyone on the team busy with
team_cancel: cancel a queued request to a teammate
team_done: the teammate closes its request with a result
team_fail: the teammate closes its request as failed
team_merge: resolve a merge conflict as the integrator
team_notes: a teammate's notes
tips_list: tips vyre shows and which were dismissed
undo_list: what was done on my behalf that can be undone
undo_run: undo something that was done for me
update_status: is there a newer version of vyre; check for updates
vitals_summary: my notebook has been slow, is anything wrong with the machine; cpu and memory numbers of this device
vyre_core: what modules does vyre have; what is installed and running
watchers_list: which watchers exist
watchers_test: dry run a watcher
watchers_create: watch a website and tell me when it changes; turn on a watcher
watchers_card: what a watcher will do before turning it on
watchers_preset: write a watcher for a mailbox or a common source
watchers_pause: pause the price watcher; stop a watcher
watchers_logs: a watcher's recent runs
watchers_items: what items have watchers found
work_project_move-plan: what moving a project to another space would carry
work_chat_list: the team chats in this space
work_chat_get: one team chat and the assistants in it
work_chat_upgrade-plan: what moving my chats to my other space would carry
work_chat_span: read lines of a team chat word for word
work_tools: what can I do with the records of this space; list the customer and matter tools
work_call: create or update a record; run a records action
work_situation: where am I; my role and what is in scope in this space
work_team_context: what a teammate starts with on a project
work_team_doing: what each teammate is doing right now
work_know_search: find records in my workspace about the smith case; search the space's records by meaning
work_know_answer: answer a question from the space's own records
work_know_suggestions: facts memory suggests for a record
chrome_snapshot: what controls are on the page; read the current web page
chrome_open: open this web address in the browser; go to a url
chrome_click: click the save button in the browser; press a button on the page
chrome_type: type text into a field on the page
chrome_screenshot: take a picture of the browser page
hands-desktop_tree: the controls of an app on the agent's computer
hands-desktop_apps: which apps are running on the agent's computer
hands-desktop_screenshot: take a picture of what is on my screen; screenshot the whole desktop
hands-desktop_act: press or type into a control on the agent's desktop
memory_search: find the passage where we talked about something; search past sessions by meaning
memory_markers: the memory of the projects I may follow
memory_follow: ask another project's memory a question
memory_space_recall: the facts this space has filed
memory_space_file: file a lasting fact in this space's memory
memory_turn: read a past stretch of a session word for word
`;

/** @type {Record<string, string[]>} */
export const TOOL_ASKS = Object.fromEntries(TABLE.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => { const i = l.indexOf(":"); return [l.slice(0, i), l.slice(i + 1).split(";").map((x) => x.trim()).filter(Boolean)]; }));

// A second line per tool in other words: shorter, keyword-like, or phrased as a wish, with the other common names for the same thing (site, web page; external, outside; helper, agent, teammate; undo, reverse, revert).
const MORE = `
threads_start: new session; launch a claude code run in a directory; kick off a background coding task
threads_send: reply to a running session; add to the conversation; follow up in the chat
threads_list: running sessions; all open chats; background sessions still going; what conversations are active
threads_get: details of a session; what happened in this chat; events of a conversation
threads_asks: pending questions from sessions; permission prompts waiting; who needs my yes
threads_watch: notify me when a session finishes its turn; alert when a chat asks a question or stops; let me know when the run ends
threads_interrupt: cancel the current turn; hit escape on a session; halt generation without closing the chat
threads_switch: move this chat to another provider; continue with codex or another account; change vendor mid conversation
threads_model: switch this session to a cheaper or stronger model; use haiku for this chat; change the model for the session
threads_effort: reasoning level for a chat; make the model think harder or less
threads_fork: branch off a session; make a copy of the conversation to experiment; clone this chat
threads_rename: change the title of a session; call this chat something else
threads_archive: file away a conversation; shelve a session; clean up finished chats
agents_usage: how much has each agent spent; tokens and cost per agent; agent budget used
agents_list: roster of agents; all assistants and what they do now
agents_ask: message another agent; consult a different agent
vault_list: inventory of saved credentials; names of stored secrets; what do I have in the vault
vault_generate: create a strong random password and store it; new secret generated for me
vault_import: migrate passwords from another manager; bring in env files
vault_request: use an api key without exposing it; authenticated http call to a service
vault_ssh_keys: which ssh keys do I have; public keys on this machine
vault_agent_grant: allow an agent to log in to a website; give the agent a login for a site
vault_revoke: remove access to a secret from a module
vault_rotation: when and how a secret gets changed; key rotation steps
artifacts_list: all my documents; recent reports and pages
artifacts_create: author a new document; build a web page or small app for the user; produce a report
artifacts_export: save a document to a file; give me the file of this page
artifacts_search: look for a document by its words
google_calendar_create: book a meeting; schedule a call with someone on a day; put an appointment on the calendar
google_calendar_today: today's schedule; what meetings do I have today
google_calendar_list: events this week; what is booked between two dates; my schedule for the week
google_calendar_search: find a meeting by name
google_mail_search: look for emails; find messages from a sender; inbox search
google_mail_send: email this person; send a message to a client
google_mail_draft: prepare an email for review; save a reply as draft
mail_search: look for email in any account; search all mailboxes
mail_send: email someone from any of my accounts
planner_agenda: what is on my schedule this week; timetable of reminders and events for a period
planner_add: create a reminder; add an alarm for tomorrow; new task on my list; set a timer
planner_list: my open tasks; list reminders and todos
planner_upcoming: next alarms that will go off; reminders coming up
publish_list: which websites have I put online; list my published sites; every site and its address
publish_publish: go live with the site; push the site to production; release the website
publish_create: new website project; set up a site to publish
publish_status: is my site up; address and stage of a site
publish_rollback: revert the site to the previous release; undo the last deploy
names_check: is this name available; can I register this name for my box; is the name taken
names_status: what is my box called; the name this box holds
team_add: add a designer helper to my project; hire a new agent role; create a teammate for a role
team_ask: assign work to the designer; ask the backend developer to do something; delegate to a teammate
team_list: the helpers on a project; which teammates does this project have
team_status: progress of a delegated request; is the teammate done yet
mcp_servers: external tool servers; which outside tool servers can I use; list mcp connections
mcp_tools: what tools do the external servers offer
mcp_call: run a tool from an external server; use an outside tool
connectors_catalog: apps that can be integrated; integrations available
connectors_connection_check: is the integration working; is my link to that app healthy; test a connection
connectors_connection_list: my integrations and their status lights
connectors_connection_propose: add an integration; set up a new connection to a service
chrome_open: go to a website in the browser; navigate to a page; visit a url
chrome_click: press a button on the web page; click a link
chrome_type: enter text in a form field on the web page
chrome_snapshot: see what is on the web page; list the buttons and fields
chrome_screenshot: capture the browser page as an image
hands-desktop_screenshot: capture the whole desktop; screen picture of the agent's computer
undo_run: reverse something the assistant did for me; revert an action taken on my behalf
undo_list: things the assistant did that I could reverse; recent actions I can take back
assistant_log: history of what the assistant did; audit trail of actions on my behalf
assistant_patterns: recurring patterns in my work; what habits has memory seen
recall_search: find the old chat where we fixed a bug; look through earlier sessions for a topic; search conversation history
memory_search: search earlier conversations by meaning
memory_ask: remind me what we decided; question about my past work
memory_remember: store this as a lasting fact; save a decision for later
memory_correct: update a wrong fact; correct what is remembered
sessions_models: which ai models can I switch this chat to; models I can pick for a chat; list model choices
sessions_models_get: which model does each kind of session use by default
sessions_accounts_list: logged in accounts of each ai provider; my ai accounts
sessions_usage_get: plan usage and limits of my claude subscription; how close am I to the limit
spend_summary: money spent on ai models today; provider spend and caps
system_info: version and platform of vyre; about this installation
update_status: new release available; am I on the latest vyre
vitals_summary: how is this computer doing; cpu memory and disk numbers
files_search: locate a file on disk by its name
glass_files_move: rename a file on the server; move a file on the remote computer
glass_files_list: browse a folder on the remote machine
glass_files_upload: send a file to the remote computer
flows_define: create an automation from text; write a workflow
flows_list: all automations in this space
flows_start: trigger an automation manually
watchers_create: monitor a source and alert me; keep an eye on a page and notify me of changes
watchers_list: all monitors I have
goals_list: my objectives and their progress
goals_set: create a goal with steps
projects_list: all my projects
docs_find: help on how to do something in vyre; documentation search
skills_find: is there a skill for this; find a recipe for this task
gate_request: ask the user to approve sending; outbound action needing a yes
files_preview: look at the first lines of a file; peek at the start of a file
files_stat: how big is a folder and when was it changed; size and date of a file
flows_runs: what happened in the last runs of an automation
connectors_catalog: list the apps I can connect
artifacts_update: save a new version of a page
artifacts_undelete: undo the last delete of a document
link_status: list paired phones and computers
computers_pause: take over from the agent; give back the keyboard
agents_ask: tell another agent what I need and wait for the answer
settings_schema: what settings can be changed
sessions_models: which models can a session use
sessions_accounts_list: which provider accounts are signed in
sessions_limits_get: how much of the usage limit is left
`;
for (const l of MORE.split("\n").map((x) => x.trim()).filter(Boolean)) { const i = l.indexOf(":"); const k = l.slice(0, i); (TOOL_ASKS[k] ||= []).push(...l.slice(i + 1).split(";").map((x) => x.trim()).filter(Boolean)); }
