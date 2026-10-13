// Industry journeys for vyre.run/for/. Data only: scripts/site/industries.mjs turns each entry into a page.
// Every Vyre name here is checked against docs/architecture/features and docs/for-agents/MAP-YOUR-BUSINESS.md.
// The firms are invented. Text may contain inline HTML (links, entities); it is written to the page as is.

const GOOGLE = ['Google Workspace', 'Today', 'Mail and calendar connect per member. Drive folders link as Files.'];
const M365 = ['Microsoft 365', 'Today', 'Mail, calendar and files connect per member.'];
const DROPBOX = ['Dropbox', 'Today', 'Folders link as Files, read through each person’s own account.'];
const DOCUSIGN = ['DocuSign', 'Connection', 'Vyre signs documents itself. A Connection reaches DocuSign if you keep using it.'];
const ZOHO = ['Zoho', 'Connection', 'A Connection and a Flow step today. An Integration is the Next step.'];
const RING = ['RingCentral', 'Connection', 'A Connection and a Flow step today. An Integration is the Next step.'];

export const INDUSTRIES = [
  {
    slug: 'law-firms', short: 'Law firms', name: 'a law firm', firm: 'Alder Row Legal',
    title: 'Vyre for law firms: a client journey from inquiry to closed matter',
    desc: 'How a law firm runs as an AI-native firm on Vyre: intake, conflict check, engagement letter, a matter from a Playbook, deadlines, documents, signing and billing hand-off.',
    h1: 'A law firm, <b>run as an AI-native firm.</b>',
    lead: 'One client, one matter, from the first inquiry to the billing hand-off. Alder Row Legal is an invented two-practice firm, personal injury and estate planning. Every step below uses a piece of Vyre that exists today, and the people keep every decision that matters.',
    ogSub: 'Intake to closed matter, with agents doing the drafting and people making the calls.',
    summary: 'Inquiry, screening and conflict check, consultation, engagement letter signed, matter opened from a Playbook, deadlines from a trigger date, documents from the firm’s own templates, client updates, billing hand-off.',
    journey: [
      ['Inquiry comes in', 'A web form, a call to a Flow’s path or a new email in a watched mailbox starts the intake Flow. It finds or creates the Contact and creates a Lead.', ['Flows', 'Records']],
      ['Screening and conflict check', 'The intake agent fills in practice area and summary, then searches existing clients and parties for the names in the inquiry. A hit goes to the responsible attorney under Needs you. No hit moves the Lead on.', ['Agents', 'Needs you']],
      ['Consultation', 'A Lead entering “Meeting booked” creates an Appointment and drafts the confirmation. The email waits at the Gate until the attorney approves the words.', ['Flows', 'Gate']],
      ['Engagement letter signed', 'A Lead entering “Qualified” fills the engagement letter from the client record and sends it for signature. The client signs without an account and the signed copy files on the record.', ['Documents', 'Signing']],
      ['Matter opens from a Playbook', 'When the signature event arrives, a Flow reads the practice area, branches and starts the matching Playbook. The matter appears with its stages, its tasks and who does each one.', ['Playbooks', 'Flows']],
      ['Deadlines from a trigger date', 'The matter carries dates such as the accident date or the hearing date. A Flow waits until a date field plus an offset, then assigns the task to the attorney with a paralegal following. The reviewer agent checks each date against the rule the firm wrote down.', ['Flows', 'Agents']],
      ['Documents and client updates', 'The drafting agent completes missing fields and asks Documents to fill the firm’s own Word template. A stage change drafts the client update, and the attorney approves it before it leaves.', ['Documents', 'Gate']],
      ['Closing and billing hand-off', 'A matter entering “Closed” asks the responsible attorney, then assigns the billing task with the matter’s fields filled in. A Connection call can post the same fields to the billing tool.', ['Flows', 'Connections']],
    ],
    records: [
      { name: 'Lead', src: 'law-firm Kit', fields: [['contact', 'link'], ['practice area', 'choice'], ['source', 'choice'], ['summary', 'rich text'], ['stage', 'New to Converted']], links: 'Links to a Contact. Board by stage.' },
      { name: 'Client', src: 'law-firm Kit', fields: [['contact', 'link'], ['practice area', 'choice'], ['since', 'date'], ['stage', 'Onboarding, Active, Closed']], links: 'Has many matters.' },
      { name: 'Matter', src: 'built-in project', fields: [['name', 'text'], ['client', 'link'], ['owner', 'person'], ['practice area', 'choice'], ['accident date', 'date'], ['hearing date', 'date']], links: 'Tokens such as {matter.client.email} reach across links.' },
      { name: 'Party', src: 'your own type', fields: [['name', 'text'], ['role', 'choice'], ['matter', 'link'], ['ID number', 'sealed']], links: 'Searched by the conflict check. The ID number is sealed.' },
    ],
    recordsNote: 'The law-firm Kit starts you with lead, appointment and client types and an estate-plan Playbook. Everything else is a type you add in Customize.',
    playbooks: [
      { name: 'Personal injury', stages: [['Intake', [['Open file, send records requests', 'Paralegal'], ['Confirm no conflict', 'Reviewer agent']]], ['Treatment', [['Collect medical records', 'Paralegal'], ['Monthly client check-in draft', 'Updates agent']]], ['Demand', [['Draft demand letter', 'Drafting agent'], ['Approve demand', 'Attorney']]], ['Resolution', [['Track offers', 'Attorney'], ['Draft settlement statement', 'Drafting agent']]], ['Closing', [['Close file and hand off billing', 'Billing']]]] },
      { name: 'Estate plan', stages: [['Questionnaire', [['Send questionnaire', 'Intake agent'], ['Review answers', 'Paralegal']]], ['Drafting', [['Fill will and trust templates', 'Drafting agent'], ['Check against questionnaire', 'Reviewer agent']]], ['Signing meeting', [['Schedule signing', 'Paralegal'], ['Attorney review', 'Attorney']]], ['Funding', [['Funding checklist', 'Paralegal']]], ['Closed', [['Close and archive', 'Billing']]]] },
    ],
    flows: [
      { name: 'New inquiry', chips: [['t', 'A form is submitted'], ['', 'Find or create the contact'], ['', 'Create a Lead'], ['a', 'Intake agent screens it'], ['q', 'Ask the attorney if a name matches'], ['g', 'Confirmation email held']], note: 'A person approved this Flow once. Each run has its own page with a step timeline.' },
      { name: 'Engagement', chips: [['t', 'A Lead enters Qualified'], ['', 'Fill the engagement letter'], ['', 'Send for signature'], ['', 'Wait for the signature'], ['', 'Start the matter’s Playbook'], ['q', 'Assign the first task']], note: 'The signature event, documents.signed, starts the next step. A decline starts a different path.' },
      { name: 'Hearing watch', chips: [['t', 'A hearing date is set'], ['', 'Wait until 14 days before'], ['', 'Assign a task to the attorney'], ['a', 'Reviewer checks the date'], ['g', 'Reminder to the client held']], note: 'The offset is the firm’s own number. The Flow only does the arithmetic.' },
    ],
    agents: [
      ['IN', 'Intake', 'Reads each new inquiry, fills the Lead, and searches clients and parties for matching names.', 'The intake project', 'Everyone in the Space as Can use. Only the managing partner can edit it.', 'Send anything. It asks, and a conflict hit goes to a person.'],
      ['DR', 'Drafting', 'Picks the template for the matter, completes missing record fields and asks Documents to fill the firm’s Word file.', 'Matters it is assigned to', 'Attorneys and paralegals.', 'Retype a firm document. A wrong value is fixed in the record or the template.'],
      ['RV', 'Reviewer', 'Checks a draft or a computed date against the rules written in its AGENTS.md before the attorney sees it.', 'Every matter project', 'Attorneys.', 'Approve. It marks a task stuck with a plain reason when it cannot decide.'],
      ['UP', 'Updates', 'Drafts the client update when a matter changes stage, in the firm’s tone.', 'Active matters', 'Paralegals.', 'Email a client. The draft waits at the Gate.'],
    ],
    needs: [
      ['Conflict check', 'Possible match: the party “Holloway Freight” is a current client on another matter.', ['Review', 'Clear']],
      ['Held email', 'Engagement letter cover note to Daniel Reyes. 84 words.', ['Approve', 'Edit']],
      ['Stuck task', 'Intake agent: the form has no practice area.', ['Open']],
    ],
    trio: [
      ['Documents and Signing', 'Engagement letters, fee agreements and client letters are the firm’s own Word templates, filled from the matter and the records linked to it. The signed copy files on the matter and starts the next Flow.'],
      ['Vault', 'The e-filing login, the bar portal and the court calendar sit in the Vault. An agent uses a credential without seeing it, and each attorney has a private vault the firm cannot read.'],
      ['Sites', 'An agent builds the firm’s consultation page and intake form from its records and brand, previews it at a private address and puts it live on one yes. Every version stays in the history.'],
    ],
    stack: [['Clio', 'Coming in 0.5.2', 'A planned packaged Integration. Today, a Connection and a Flow step, or a custom module.'], ['Lawmatics', 'Coming in 0.5.2', 'A planned packaged Integration. Today, a Connection and a Flow step.'], ['Practice tools', 'Connection', 'Document, calendar and e-filing tools with an API connect the same way.'], ZOHO, RING, GOOGLE, M365, DROPBOX, DOCUSIGN],
    faq: null,
  },

  {
    slug: 'accounting-firms', short: 'Accounting firms', name: 'an accounting firm', firm: 'Brightwater Accounting',
    title: 'Vyre for accounting firms: onboarding, document collection and the monthly close',
    desc: 'How an accounting firm runs as an AI-native firm on Vyre: client onboarding, document collection, a monthly close Playbook, tax season tracks, engagement letters and reminders.',
    h1: 'An accounting firm, <b>run as an AI-native firm.</b>',
    lead: 'A new client, then a year of work on a calendar. Brightwater Accounting is an invented firm with three tracks: monthly bookkeeping, individual returns and business returns. Each track is its own Playbook with its own Flows over the same client records.',
    ogSub: 'Client onboarding to monthly close and tax season, with agents chasing and people signing off.',
    summary: 'Inquiry and scoping, engagement letter signed, client onboarding, document collection with reminders, a monthly close Playbook, tax season tracks, review and delivery, billing and renewal.',
    journey: [
      ['Inquiry and scoping', 'A form or a call starts a Flow that creates the prospect and a scoping task. The intake agent drafts the questions: entity type, software, volume, year-end.', ['Flows', 'Agents']],
      ['Proposal and engagement letter', 'The partner approves the scope. Documents fills the engagement letter from the client record and sends it for signature. The client signs without an account.', ['Documents', 'Signing']],
      ['Client onboarding', 'The signature starts onboarding. A Flow creates the engagement records, assigns the setup tasks and sends the first document request. Tax IDs and bank numbers go in sealed fields.', ['Records', 'Flows']],
      ['Document collection', 'Each request is a record with a due date. A schedule inside business hours finds the overdue ones and drafts a reminder. The reminder waits at the Gate, and the reply starts the next step.', ['Flows', 'Gate']],
      ['Monthly close Playbook', 'On the first business day a Flow starts the close Playbook for every active monthly client: collect, reconcile, review, report, deliver. Each task has a doer and a checker.', ['Playbooks', 'Flows']],
      ['Tax season tracks', 'Individual and business returns each have their own Playbook and stage set. A field on the engagement names the track, and a Flow starts the right Playbook.', ['Playbooks', 'Records']],
      ['Review and delivery', 'The reviewer agent compares the working papers against the firm’s checklist. The partner approves under Needs you, and the delivery email goes out only after a yes.', ['Agents', 'Needs you']],
      ['Billing and renewal', 'Closed work assigns the billing task with fees filled in. A yearly Flow drafts the renewal letter, sends it for signature and moves the engagement to the new year.', ['Flows', 'Signing']],
    ],
    records: [
      { name: 'Client', src: 'built-in organization', fields: [['name', 'text'], ['entity type', 'choice'], ['year end', 'date'], ['tax ID', 'sealed'], ['bank account', 'sealed']], links: 'Contacts link to the organization.' },
      { name: 'Engagement', src: 'built-in project', fields: [['client', 'link'], ['service', 'choice'], ['period', 'text'], ['owner', 'person'], ['due', 'date'], ['stage', 'by track']], links: 'The service field picks the track and the stage set.' },
      { name: 'Document request', src: 'your own type', fields: [['engagement', 'link'], ['item', 'text'], ['due', 'date'], ['received', 'date'], ['stage', 'Open, Received']], links: 'Overdue ones feed the reminder Flow.' },
      { name: 'Deliverable', src: 'your own type', fields: [['engagement', 'link'], ['kind', 'choice'], ['file', 'file'], ['approved by', 'person']], links: 'Links to the file in the Space’s Files.' },
    ],
    recordsNote: 'These are types you define in Customize, or that an agent defines for you over MCP. Fields sit in named groups, and fields marked sealed show an agent a placeholder, never the value.',
    playbooks: [
      { name: 'Monthly close', stages: [['Collect', [['Check all requests received', 'Chaser agent'], ['Chase missing items', 'Chaser agent']]], ['Reconcile', [['Reconcile accounts', 'Bookkeeper'], ['Flag unusual items', 'Preparer agent']]], ['Review', [['Review the close', 'Reviewer agent'], ['Approve', 'Manager']]], ['Report', [['Fill the management report', 'Drafting agent']]], ['Deliver', [['Send the report', 'Manager']]]] },
      { name: 'Individual return', stages: [['Organizer', [['Send the organizer', 'Intake agent']]], ['Documents in', [['Check the document list', 'Chaser agent'], ['Chase missing items', 'Chaser agent']]], ['Prepare', [['Prepare the return', 'Preparer']]], ['Review', [['Review against the checklist', 'Reviewer agent'], ['Sign off', 'Partner']]], ['Client approval', [['Send for signature', 'Manager']]]] },
      { name: 'Business return', stages: [['Kickoff', [['Confirm entity details', 'Manager']]], ['Documents in', [['Collect year-end files', 'Chaser agent']]], ['Prepare', [['Prepare the return', 'Preparer']]], ['Review', [['Reviewer pass', 'Reviewer agent'], ['Partner review', 'Partner']]], ['Filed', [['Record the filing date', 'Manager']]]] },
    ],
    flows: [
      { name: 'Close kickoff', chips: [['t', 'First business day, 8:00'], ['', 'Find active monthly clients'], ['', 'For each: start the close Playbook'], ['q', 'Assign the first task']], note: 'A schedule reads the Space’s time zone and can skip holidays.' },
      { name: 'Document chase', chips: [['t', 'Every day in business hours'], ['', 'Find overdue requests'], ['a', 'Chaser agent drafts the reminder'], ['g', 'Reminder email held'], ['', 'Wait for the reply or 3 days']], note: 'The Flow carries its own limits on how many it sends. A hit limit stops for a person.' },
      { name: 'Engagement signed', chips: [['t', 'documents.signed'], ['', 'Move the client to Active'], ['', 'Create the engagement'], ['', 'Start the track’s Playbook'], ['q', 'Assign setup tasks']], note: 'The same pattern renews each year.' },
    ],
    agents: [
      ['IN', 'Intake', 'Turns a new inquiry into scoping questions and a draft proposal outline.', 'The prospects project', 'Partners and managers.', 'Send the proposal. A partner approves it.'],
      ['CH', 'Chaser', 'Reads open document requests and drafts the reminder in the firm’s tone.', 'Active engagements', 'Managers.', 'Send a reminder by itself. Each one waits at the Gate.'],
      ['PR', 'Preparer assistant', 'Flags unusual items and fills the working-paper summary from the records.', 'Engagements assigned to it', 'Bookkeepers and preparers.', 'See a tax ID or bank number. Sealed fields show a placeholder.'],
      ['RV', 'Reviewer', 'Checks a close or a return against the firm’s checklist and marks what it could not verify.', 'Every engagement project', 'Managers and partners.', 'Approve. A partner does that.'],
    ],
    needs: [
      ['Held email', 'Reminder to Marlow Dental: 3 items still missing for March. 61 words.', ['Approve', 'Edit']],
      ['Review', 'March close for Marlow Dental is ready for the partner.', ['Open']],
      ['Stuck task', 'Chaser agent: two clients share one contact email.', ['Open']],
    ],
    trio: [
      ['Documents and Signing', 'Engagement letters, management reports and authorization forms are the firm’s own templates, filled from the engagement and the client. Signers need no account, and the signed copy files on the engagement.'],
      ['Vault', 'Software logins, portal access and shared mailbox passwords sit in the Vault, shared as Can use. The chaser and reviewer agents use a login without seeing it.'],
      ['Sites', 'An agent builds a page for each service that says what the firm needs each month and how to send it, plus the intake form. It goes live on one yes.'],
    ],
    stack: [['QuickBooks', 'Connection', 'A Connection and a Flow step today. An Integration is the Next step.'], ['Xero', 'Connection', 'A Connection and a Flow step today. An Integration is the Next step.'], ['Karbon', 'Connection', 'A Connection and a Flow step today. An Integration is the Next step.'], ZOHO, RING, GOOGLE, M365, DROPBOX, DOCUSIGN],
  },

  {
    slug: 'consulting-firms', short: 'Consulting firms', name: 'a consulting firm', firm: 'Northfield Advisory',
    title: 'Vyre for consulting firms: proposal to delivered engagement',
    desc: 'How a consulting firm runs as an AI-native firm on Vyre: inquiry, scoping, proposal, statement of work signed, an engagement from a Playbook, weekly status and change requests.',
    h1: 'A consulting firm, <b>run as an AI-native firm.</b>',
    lead: 'Northfield Advisory is an invented six-person firm that sells diagnostics, programs and retainers. The work is judgment, so the agents carry the research, drafts and status writing, and the partners keep the calls.',
    ogSub: 'Scoping to delivery, with agents writing the status and partners deciding.',
    summary: 'Inquiry, scoping call, proposal, statement of work signed, engagement from a Playbook, weekly status, change requests, final report and renewal.',
    journey: [
      ['Inquiry comes in', 'A form, an email to a shared mailbox or a referral entered by hand starts a Flow. It finds or creates the organization and the contact, and creates an Opportunity.', ['Flows', 'Records']],
      ['Research and scoping', 'The research agent reads the company’s public material and drafts a one-page brief. The partner reads it before the scoping call.', ['Agents', 'Needs you']],
      ['Proposal', 'The proposal agent assembles the draft from the firm’s past work and price list. The reviewer checks scope and price against the rules in its AGENTS.md. The partner edits and approves.', ['Agents', 'Documents']],
      ['Statement of work signed', 'Documents fills the statement of work from the Opportunity and sends it for signature. The signed copy files on the engagement.', ['Documents', 'Signing']],
      ['Engagement from a Playbook', 'The signature starts the Playbook for the kind of work: diagnostic, program or retainer. Phases, tasks, owners and due offsets arrive together.', ['Playbooks', 'Flows']],
      ['Weekly status', 'Every Friday a schedule asks the status agent to read the week’s tasks and decisions for each engagement and draft the client update. The partner approves each one.', ['Flows', 'Gate']],
      ['Change requests', 'A new request is a record. The Flow asks the partner, updates scope and fee on a yes, and drafts the change note for the client.', ['Records', 'Needs you']],
      ['Final report and renewal', 'The last phase fills the report template, sends it for the client’s sign-off and opens the renewal Opportunity ninety days later.', ['Documents', 'Flows']],
    ],
    records: [
      { name: 'Client', src: 'built-in organization', fields: [['name', 'text'], ['industry', 'choice'], ['owner', 'person'], ['billing contact', 'link']], links: 'Contacts link to the organization.' },
      { name: 'Opportunity', src: 'your own type', fields: [['client', 'link'], ['offer', 'choice'], ['fee', 'money'], ['expected close', 'date'], ['stage', 'Lead to Won or Lost']], links: 'Board by stage. A won Opportunity starts an engagement.' },
      { name: 'Engagement', src: 'built-in project', fields: [['client', 'link'], ['offer', 'choice'], ['start', 'date'], ['end', 'date'], ['lead partner', 'person'], ['fee', 'money']], links: 'The offer field picks the Playbook.' },
      { name: 'Change request', src: 'your own type', fields: [['engagement', 'link'], ['summary', 'rich text'], ['fee change', 'money'], ['decision', 'choice']], links: 'A yes updates the engagement.' },
    ],
    recordsNote: 'Fields sit in named groups, and views are boards, calendars and dashboards. The partner’s dashboard of open Opportunities and live engagements is a saved view.',
    playbooks: [
      { name: 'Diagnostic', stages: [['Kickoff', [['Send the data request', 'Analyst'], ['Book interviews', 'Coordinator']]], ['Interviews', [['Run and note interviews', 'Consultant'], ['Summarize themes', 'Research agent']]], ['Findings', [['Draft findings', 'Drafting agent'], ['Review against the evidence', 'Reviewer agent']]], ['Readout', [['Partner readout', 'Partner']]]] },
      { name: 'Program', stages: [['Plan', [['Workplan and RACI', 'Lead consultant']]], ['Run', [['Weekly status draft', 'Status agent'], ['Steering meeting', 'Partner']]], ['Hand over', [['Final report', 'Drafting agent'], ['Client sign-off', 'Partner']]]] },
      { name: 'Retainer', stages: [['Monthly plan', [['Agree this month’s focus', 'Lead consultant']]], ['Deliver', [['Track hours and output', 'Coordinator']]], ['Month report', [['Draft the report', 'Status agent'], ['Approve', 'Partner']]]] },
    ],
    flows: [
      { name: 'Opportunity won', chips: [['t', 'An Opportunity enters Won'], ['', 'Fill the statement of work'], ['', 'Send for signature'], ['', 'Wait for the signature'], ['', 'Start the offer’s Playbook'], ['q', 'Assign the kickoff']], note: 'The Flow reads the offer field and branches. In 0.5 the caller names the Playbook, so the Flow does.' },
      { name: 'Friday status', chips: [['t', 'Every Friday, 3:00'], ['', 'Find live engagements'], ['a', 'Status agent drafts each update'], ['q', 'Partner reviews'], ['g', 'Client email held']], note: 'One run per engagement, each with its own page.' },
      { name: 'Change request', chips: [['t', 'A change request is created'], ['q', 'Ask the lead partner'], ['', 'Update scope and fee on yes'], ['a', 'Draft the change note'], ['g', 'Note to client held']], note: 'The Flow stops at the question until a person answers.' },
    ],
    agents: [
      ['RS', 'Research', 'Reads public material on a company and writes a one-page brief with sources.', 'The pipeline project', 'Partners.', 'Contact the company. It cannot send.'],
      ['PR', 'Proposal', 'Assembles a proposal from past work and the price list.', 'Open Opportunities', 'Partners and the lead consultant.', 'Change a price outside the list. It asks.'],
      ['RV', 'Reviewer', 'Checks scope, price and claims against the firm’s rules before a partner sees a draft.', 'Pipeline and engagements', 'Partners.', 'Approve. It marks a task stuck with a plain reason.'],
      ['ST', 'Status', 'Reads the week’s tasks and decisions and drafts the client update.', 'Live engagements', 'Lead consultants.', 'Email the client. The draft waits at the Gate.'],
    ],
    needs: [
      ['Proposal', 'Proposal for Kestrel Logistics, diagnostic, fee 38,000. Reviewer found no issues.', ['Open', 'Approve']],
      ['Held email', 'Weekly status to Kestrel Logistics. 190 words.', ['Approve', 'Edit']],
      ['Question', 'Change request: add two interviews, fee plus 4,500. Accept?', ['Yes', 'No']],
    ],
    trio: [
      ['Documents and Signing', 'Statements of work, change notes and final reports are the firm’s own Word templates, filled from the engagement. The client signs without an account.'],
      ['Vault', 'Client data-room logins and survey tools sit in the Vault. Agents use them for one job and never see them. Each consultant has a private vault.'],
      ['Sites', 'An agent builds a page for each offer and the inquiry form from the firm’s records and brand. It previews at a private address and goes live on one yes.'],
    ],
    stack: [ZOHO, ['QuickBooks', 'Connection', 'A Connection and a Flow step today. An Integration is the Next step.'], ['Xero', 'Connection', 'A Connection and a Flow step today. An Integration is the Next step.'], RING, GOOGLE, M365, DROPBOX, DOCUSIGN],
  },

  {
    slug: 'marketing-agencies', short: 'Marketing and creative agencies', name: 'a marketing agency', firm: 'Copperline Studio',
    title: 'Vyre for marketing and creative agencies: brief to approved campaign',
    desc: 'How a marketing or creative agency runs as an AI-native firm on Vyre: brief, scope, onboarding, campaign Playbooks, creative review rounds, client approval, reporting and renewal.',
    h1: 'An agency, <b>run as an AI-native firm.</b>',
    lead: 'Copperline Studio is an invented eight-person agency with three offers: a social retainer, paid media and website builds. Work moves in rounds, so the Flows count rounds, the agents draft and check, and the client’s yes is a signed record.',
    ogSub: 'Brief to approved campaign, with rounds, reviews and reports handled in one place.',
    summary: 'Inquiry, discovery and brief, proposal and statement of work signed, onboarding with access in the Vault, a campaign Playbook per offer, creative review rounds, client approval, monthly report, renewal.',
    journey: [
      ['Inquiry comes in', 'A form or an email starts the Flow. It creates the Contact and a Prospect, and the intake agent drafts the discovery questions.', ['Flows', 'Agents']],
      ['Discovery and brief', 'A call’s notes land on the Prospect. The brief agent turns them into a written brief with goals, audience and budget. The account lead edits it.', ['Agents', 'Records']],
      ['Proposal and statement of work', 'The proposal is filled from the brief and the price list, then sent for signature. The client signs without an account and the signed copy files on the client record.', ['Documents', 'Signing']],
      ['Onboarding', 'The signature creates the client record and the campaign. The access checklist runs: ad accounts, analytics, brand files. Logins go in the Vault, and agents use them without seeing them.', ['Vault', 'Flows']],
      ['Campaign Playbook', 'The offer picks the Playbook: social retainer, paid media or website build. Each has its stages, tasks and doers, side by side over the same client records.', ['Playbooks', 'Records']],
      ['Creative review rounds', 'Each deliverable is a record with a round number. The reviewer agent checks it against the brief and brand rules, then it goes to the account lead. Round three asks a partner.', ['Agents', 'Needs you']],
      ['Client approval', 'The approved asset is sent to the client for sign-off. A yes moves the record to Approved and starts production. Publishing a page or a post waits at the Gate.', ['Signing', 'Gate']],
      ['Reporting and renewal', 'Each month the report agent assembles the numbers into the report template. The account lead approves, and a renewal Flow starts sixty days before the term ends.', ['Flows', 'Documents']],
    ],
    records: [
      { name: 'Client', src: 'built-in organization', fields: [['name', 'text'], ['account lead', 'person'], ['term end', 'date'], ['retainer', 'money']], links: 'Contacts link to the organization.' },
      { name: 'Campaign', src: 'built-in project', fields: [['client', 'link'], ['offer', 'choice'], ['goal', 'rich text'], ['budget', 'money'], ['stage', 'by offer']], links: 'The offer picks the Playbook and the stage set.' },
      { name: 'Deliverable', src: 'your own type', fields: [['campaign', 'link'], ['kind', 'choice'], ['round', 'number'], ['file', 'file'], ['stage', 'Draft to Approved']], links: 'A Flow counts the rounds.' },
      { name: 'Access item', src: 'your own type', fields: [['client', 'link'], ['system', 'choice'], ['vault item', 'link'], ['stage', 'Requested, Granted']], links: 'Points at a Vault item, never holds the login.' },
    ],
    recordsNote: 'A board by stage for deliverables and a calendar by due date are saved views. Money fields total across a client’s campaigns.',
    playbooks: [
      { name: 'Social retainer', stages: [['Plan', [['Monthly content plan', 'Content agent'], ['Approve the plan', 'Account lead']]], ['Produce', [['Draft posts and visuals', 'Content agent'], ['Brand check', 'Reviewer agent']]], ['Approve', [['Send to client', 'Account lead']]], ['Report', [['Monthly report', 'Report agent']]]] },
      { name: 'Paid media', stages: [['Setup', [['Account access and tracking', 'Media buyer']]], ['Launch', [['Draft ad copy', 'Content agent'], ['Approve spend', 'Partner']]], ['Optimize', [['Weekly review', 'Media buyer']]], ['Report', [['Monthly report', 'Report agent']]]] },
      { name: 'Website build', stages: [['Brief', [['Sitemap and copy outline', 'Content agent']]], ['Design', [['Page designs', 'Designer'], ['Brand check', 'Reviewer agent']]], ['Build', [['Build and preview', 'Site agent']]], ['Launch', [['Client approval', 'Account lead'], ['Go live', 'Partner']]]] },
    ],
    flows: [
      { name: 'Proposal signed', chips: [['t', 'documents.signed'], ['', 'Create the client and campaign'], ['', 'Start the offer’s Playbook'], ['', 'Create the access items'], ['q', 'Assign onboarding to the lead']], note: 'Each offer is its own track with its own Playbook.' },
      { name: 'Review round', chips: [['t', 'A deliverable enters Review'], ['a', 'Reviewer checks the brief'], ['q', 'Ask the account lead'], ['', 'Add one to the round'], ['g', 'Send to the client held']], note: 'Round three, by the firm’s rule, asks a partner instead.' },
      { name: 'Monthly report', chips: [['t', 'First of the month'], ['', 'Find live campaigns'], ['a', 'Report agent assembles it'], ['', 'Fill the report template'], ['g', 'Email to the client held']], note: 'The numbers come from the records or a Connection. The agent does not invent any.' },
    ],
    agents: [
      ['IN', 'Intake', 'Drafts discovery questions and files the call notes on the Prospect.', 'The prospects project', 'Account leads.', 'Contact the prospect. It cannot send.'],
      ['CT', 'Content', 'Drafts plans, copy and variations from the brief and brand rules.', 'Client campaigns', 'Account leads and designers.', 'Publish. Publishing waits at the Gate.'],
      ['RV', 'Reviewer', 'Checks each deliverable against the brief and the brand rules and names what it checked.', 'All campaigns', 'Account leads and partners.', 'Approve. It marks a task stuck with a plain reason.'],
      ['SA', 'Site', 'Builds a landing page or a site, previews it at a private address and asks to go live.', 'Website builds', 'Designers and partners.', 'Go live by itself. It takes one yes.'],
    ],
    needs: [
      ['Review', 'Round 2 of the spring launch carousel. Reviewer: matches the brief, two lines to shorten.', ['Open', 'Approve']],
      ['Go live', 'Landing page for Fernhill Cafe is ready at its private address.', ['Preview', 'Go live']],
      ['Held email', 'Monthly report to Fernhill Cafe. 120 words.', ['Approve', 'Edit']],
    ],
    trio: [
      ['Documents and Signing', 'Proposals, statements of work and approval sheets are the agency’s own templates, filled from the client and the campaign. The client signs without an account.'],
      ['Vault', 'Ad accounts, social logins and hosting sit in the Vault, shared as Can use. The content and site agents work with them and never see the values.'],
      ['Sites', 'Landing pages and whole sites for clients are built by the Site agent from the client’s records and brand, previewed privately and put live on one yes. Every version stays in the history.'],
    ],
    stack: [ZOHO, RING, GOOGLE, M365, DROPBOX, DOCUSIGN, ['QuickBooks', 'Connection', 'A Connection and a Flow step today. An Integration is the Next step.'], ['Ad and analytics platforms', 'Connection', 'Platforms with an API connect the same way, with the key in the Vault.']],
  },

  {
    slug: 'real-estate-brokerages', short: 'Real estate brokerages', name: 'a real estate brokerage', firm: 'Harborview Realty Group',
    title: 'Vyre for real estate brokerages: lead to closed transaction',
    desc: 'How a real estate brokerage runs as an AI-native firm on Vyre: lead response, agreement signed, a transaction from a Playbook, key dates from the contract date, documents and closing.',
    h1: 'A brokerage, <b>run as an AI-native firm.</b>',
    lead: 'Harborview Realty Group is an invented brokerage with twelve agents and a transaction coordinator. A deal is a string of dates. The Flows turn the contract date into the inspection, financing and closing dates, and people confirm each step that matters.',
    ogSub: 'Lead to closed transaction, with every key date on the calendar before it is due.',
    summary: 'Lead response, qualification, listing or buyer agreement signed, a transaction from a Playbook, key dates from the contract date, documents, client updates, closing and follow-up.',
    journey: [
      ['Lead comes in', 'A portal lead, an open-house form or a call to a Flow’s path creates the Contact and a Lead. The responder agent drafts a reply in minutes, and the agent assigned to the lead approves it.', ['Flows', 'Gate']],
      ['Qualification', 'The responder asks the buyer or seller the firm’s standard questions and files the answers on the Lead. A Lead entering “Qualified” assigns an agent by territory.', ['Agents', 'Records']],
      ['Agreement signed', 'Documents fills the listing agreement or the buyer agreement from the client and sends it for signature. The signer needs no account and the signed copy files on the transaction.', ['Documents', 'Signing']],
      ['Transaction from a Playbook', 'The agreement starts the Playbook for the side: listing or buyer. The transaction appears with its stages, tasks and doers.', ['Playbooks', 'Flows']],
      ['Key dates from the contract date', 'When the contract date is set, a Flow computes the inspection, financing and closing dates and waits for each. A task lands with the coordinator ahead of every one.', ['Flows', 'Records']],
      ['Documents and client updates', 'The coordinator agent fills the firm’s own forms from the transaction. Each stage change drafts an update to the client, and the agent approves it before it goes.', ['Documents', 'Gate']],
      ['Closing', 'A transaction entering “Closing” asks the agent and the coordinator to confirm the checklist. Wire instructions sit in a sealed field that an agent never reads.', ['Needs you', 'Records']],
      ['Follow-up', 'After close, a Flow waits, then drafts the thank-you, the review request and the yearly home anniversary note. Each waits for a yes.', ['Flows', 'Gate']],
    ],
    records: [
      { name: 'Lead', src: 'your own type', fields: [['contact', 'link'], ['side', 'choice'], ['area', 'choice'], ['budget', 'money'], ['source', 'choice'], ['stage', 'New to Converted']], links: 'Board by stage.' },
      { name: 'Property', src: 'your own type', fields: [['address', 'address'], ['owner', 'link'], ['list price', 'money'], ['status', 'choice']], links: 'Linked to transactions.' },
      { name: 'Transaction', src: 'built-in project', fields: [['client', 'link'], ['property', 'link'], ['side', 'choice'], ['contract date', 'date'], ['closing date', 'date'], ['wire instructions', 'sealed']], links: 'The side picks the Playbook.' },
      { name: 'Key date', src: 'your own type', fields: [['transaction', 'link'], ['kind', 'choice'], ['due', 'date'], ['done', 'boolean']], links: 'Created by the Flow and shown on a calendar view.' },
    ],
    recordsNote: 'A calendar view of Key dates across all transactions shows the coordinator the week. Fields marked sealed show an agent a placeholder, never the value.',
    playbooks: [
      { name: 'Listing side', stages: [['Prepare', [['Listing packet', 'Coordinator agent'], ['Photos and copy', 'Content agent']]], ['On market', [['Weekly activity report', 'Coordinator agent'], ['Review offers', 'Agent']]], ['Under contract', [['Key dates', 'Coordinator'], ['Disclosure docs', 'Coordinator agent']]], ['Closing', [['Final checklist', 'Coordinator']]]] },
      { name: 'Buyer side', stages: [['Search', [['Saved search and tours', 'Agent']]], ['Offer', [['Draft the offer forms', 'Coordinator agent'], ['Approve', 'Agent']]], ['Under contract', [['Key dates', 'Coordinator'], ['Inspection follow-up', 'Agent']]], ['Closing', [['Final walkthrough', 'Agent'], ['Checklist', 'Coordinator']]]] },
    ],
    flows: [
      { name: 'New lead', chips: [['t', 'A portal or form lead arrives'], ['', 'Find or create the contact'], ['', 'Create a Lead'], ['a', 'Responder drafts a reply'], ['g', 'Reply held for the agent']], note: 'The reply waits at the Gate. A person approves the exact words.' },
      { name: 'Key dates', chips: [['t', 'A contract date is set'], ['', 'Compute the key dates'], ['', 'Create a Key date for each'], ['', 'Wait until 2 days before each'], ['q', 'Assign the task to the coordinator']], note: 'The offsets are the firm’s own numbers. The Flow only does the arithmetic.' },
      { name: 'After close', chips: [['t', 'A transaction enters Closed'], ['', 'Wait 7 days'], ['a', 'Draft thank-you and review request'], ['g', 'Email held'], ['', 'Wait until the anniversary']], note: 'The wait’s deadline is recorded once, so a restart keeps it.' },
    ],
    agents: [
      ['RS', 'Responder', 'Replies to new leads in the firm’s voice and files the buyer or seller answers on the Lead.', 'The leads project', 'All agents of the brokerage.', 'Send a reply. It waits at the Gate.'],
      ['CO', 'Coordinator', 'Fills the firm’s forms from the transaction and lists what is missing.', 'Transactions it is assigned to', 'The coordinator and agents.', 'Read the wire instructions. It sees a placeholder.'],
      ['RV', 'Reviewer', 'Checks the key dates and filled forms against the contract and the firm’s checklist.', 'All transactions', 'The coordinator and the broker.', 'Approve. It marks a task stuck with a plain reason.'],
      ['CT', 'Content', 'Drafts listing copy and the weekly activity report for sellers.', 'Listing-side transactions', 'Agents.', 'Publish a listing. Publishing waits for a yes.'],
    ],
    needs: [
      ['Held email', 'Reply to Priya Anand about 14 Quay Street. 72 words.', ['Approve', 'Edit']],
      ['Check', 'Inspection date for 9 Mill Lane falls on a Sunday. Reviewer asks the coordinator.', ['Open']],
      ['Stuck task', 'Responder: the lead has no phone number or email.', ['Open']],
    ],
    trio: [
      ['Documents and Signing', 'Listing agreements, buyer agreements and addenda are the firm’s own templates, filled from the transaction and the people linked to it. Signers need no account.'],
      ['Vault', 'Lockbox codes, portal logins and the marketing accounts sit in the Vault. Wire instructions sit in a sealed field. A person reveals one on their own device.'],
      ['Sites', 'An agent builds a page for each listing from the property record, previews it at a private address and puts it live on one yes.'],
    ],
    stack: [ZOHO, RING, GOOGLE, M365, DROPBOX, DOCUSIGN, ['Transaction and listing tools', 'Connection', 'Tools with an API connect the same way, with the key in the Vault.']],
  },
];

export const BY_SLUG = Object.fromEntries(INDUSTRIES.map((d) => [d.slug, d]));
