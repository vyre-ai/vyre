// @ts-check
// lexicon — the generic words the curator needs to tell a name from everything else.
//
// Nothing here names a person or a business anyone works with. These are the words that open
// sentences, head sections of an answer, name a type of business, or name a product almost
// every session touches. They are the same for everyone, which is why they may live in code.
// Who the user is comes from config.me; who their clients are comes from their own sessions.

const words = s => new Set(s.trim().split(/\s+/).map(w => w.toLowerCase()));

/**
 * Words that start a capitalised run without being part of a name: sentence openers, pronouns,
 * modal verbs, days and months. A run that starts with one has it stripped ("Actually Dana
 * Reyes" is "Dana Reyes"), so the guard costs nothing on real names. In the prototype, without
 * this, six thousand instances of "Perfect" and "Actually" outnumbered every real name.
 */
export const OPENERS = words(`
  the this that these those there here what when where which why how who whom whose
  you your yours we our ours they their them i me my he she his her it its
  if and but or so now then also just let lets okay ok yes no not can could should would will
  may might must do does did done is are was were be been being have has had get got
  perfect great good right sure actually alright yeah please thanks thank sorry hi hello hey
  first second third next last every each some any all both more most less same other another
  new old big small only still even again once since until after before because while though
  dear per via with without from into onto about above below under over between through
  monday tuesday wednesday thursday friday saturday sunday today tomorrow yesterday tonight
  january february march april june july august september october november december
  morning afternoon evening week weekend month year quarter
  seems looks sounds feels makes takes gives goes comes means needs wants gets keeps shows
`);

/**
 * Words that make a capitalised run a heading or a label rather than a name: "Next Steps",
 * "Key Findings", "Pull Request". A run containing any of them is not a name.
 */
export const HEADINGS = words(`
  summary overview findings finding steps step notes note results result changes change issues
  issue problem problems solution solutions background context goals goal plan plans status
  update updates questions question answer answers example examples option options pros cons
  risk risks recommendation recommendations conclusion implementation testing tests test build
  deploy deployment error errors warning warnings file files folder folders section sections
  phase part table figure total totals key action actions item items task tasks todo list
  request requests pull merge branch commit commits review readme changelog license api url
  true false null none yes no ok done read write edit run bash grep glob tool tools agent agents
  session sessions prompt prompts model models user users assistant system claude code
  input output success failure failed passed pending approved open closed draft final
  details detail description title name names date dates time times version versions
  schema database table tables column columns field fields form forms page pages site sites
  project projects repo repos
`);

/**
 * Nouns that say a capitalised run is an organisation: "Harlow Legal", "Northwind Bakery".
 * Checked against the last word. Generic kinds of business, never a particular one.
 */
export const ORG_WORDS = words(`
  legal law lawyers attorneys firm llp pllc llc inc ltd corp corporation co company group
  partners associates studio studios labs lab agency media consulting consultants design
  digital solutions systems technologies technology software works industries holdings
  enterprises services insurance properties realty homes builders construction motors
  bakery cafe coffee kitchen restaurant bistro bar brewery winery farms farm market foods
  clinic dental health medical hospital pharmacy care wellness fitness gym spa salon
  academy school university college institute foundation trust fund capital ventures bank
  church club society council association union cooperative collective store shop supply
  press publishing records films pictures productions games architects architecture
`);

/**
 * Products and vendors that appear beside the work in almost every session. They are never a
 * client, and they must not vote on which client a session is about: measured on the
 * prototype's corpus, letting them vote drowned every client's share and placed 5 sessions of
 * 185. A run containing one of these words is a tool, not a name.
 */
export const TOOL_WORDS = words(`
  github gitlab bitbucket slack gmail google outlook microsoft teams excel word powerpoint
  notion linear jira confluence asana trello clickup monday airtable zapier make
  stripe paypal square quickbooks xero shopify wordpress webflow squarespace wix
  vercel netlify railway heroku render fly supabase firebase postgres postgresql mysql sqlite
  redis mongodb aws amazon azure cloudflare docker kubernetes tailscale mattermost discord
  figma canva miro loom zoom calendly dropbox box drive docs sheets youtube vimeo
  facebook instagram meta linkedin twitter tiktok whatsapp telegram
  openai chatgpt anthropic gemini copilot cursor hubspot salesforce mailchimp twilio
  sendgrid resend intercom zendesk typeform tally hotjar mixpanel amplitude segment
  node npm react next nextjs typescript javascript python rust golang java swift
  mac macos ios android windows linux ubuntu chrome safari firefox
`);

/** Domains that host mail for anyone. An address there says nothing about who someone works for. */
export const FREE_MAIL = new Set(`
  gmail.com googlemail.com outlook.com hotmail.com live.com msn.com yahoo.com ymail.com
  icloud.com me.com mac.com proton.me protonmail.com pm.me aol.com gmx.com gmx.net
  mail.com zoho.com fastmail.com hey.com yandex.com
`.trim().split(/\s+/));

/** Domains reserved for examples (RFC 2606) and addresses no person reads. */
export const RESERVED_DOMAINS = new Set(["example.com", "example.org", "example.net", "localhost", "test.com"]);
export const NO_PERSON = /^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|bounce[s]?|notifications?|alerts?|support|info|hello|contact|admin|team|help|sales|billing|accounts?|office|you|your|name|user|someone|me|test|email)$/i;

/** Top-level domains the bare-domain pattern accepts. A closed list, so "intake.tsx" is a file. */
export const TLDS = `com org net io co ai app dev law legal studio us uk ca au nz ie de fr es it nl
  se no dk fi ch at be pl pt br mx in sg hk jp kr me info biz xyz so sh run page site tech
  agency design shop store online cloud email team tools works group partners life health care`
  .trim().split(/\s+/);

/** A domain's registrable part: "app.harlowlegal.com" is "harlowlegal.com". */
export function registrable(host) {
  const parts = String(host).toLowerCase().replace(/^www\./, "").split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  // Two-label public suffixes ("co.uk", "com.au") keep three labels.
  const two = parts.slice(-2).join(".");
  if (/^(co|com|org|net|ac|gov|ltd|plc)\.[a-z]{2}$/.test(two)) return parts.slice(-3).join(".");
  return parts.slice(-2).join(".");
}

/** Letters and digits only, lowercase. How a name is compared with a domain: "Harlow Legal" is "harlowlegal". */
export const letters = s => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** The part of a domain that names its owner: "harlowlegal.com" is "harlowlegal". */
export const stemOf = domain => registrable(domain).split(".")[0];
