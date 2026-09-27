// @ts-check
// personal/words: ordinary English words, so a lowercase word can be told from a name.
//
// People type to a coding assistant in lower case: "my partner robin says", "our cat pepper".
// A word in a name's place is read as a name only when it is not an ordinary word, nor an
// ordinary word with an ending ("says", "snapped", "loving", "really"). Generic, the same for
// everyone, so it may live in code. It errs towards "not a name": a name that is also a word
// (will, rose, may) is missed rather than a word read as a name.

const words = s => new Set(s.split(/\s+/).filter(Boolean));

/** Function words, pronouns, and the commonest verbs, adjectives, adverbs and nouns of chat. */
export const COMMON = words(`
  a an the this that these those there here some any all both each every either neither no none not nor
  and or but so yet if then than because since while when whenever where wherever whether until unless though although
  as at by for from in into of off on onto out over under up down with within without about above after again against
  along among around before behind below beneath beside besides between beyond during except inside near outside past
  per round through throughout till toward towards upon via plus minus
  i me my mine myself we us our ours ourselves you your yours yourself yourselves he him his himself she her hers
  herself it its itself they them their theirs themselves one ones someone somebody something anyone anybody anything
  everyone everybody everything nobody nothing noone who whom whose which what whatever whoever why how
  im ive id ill youre youve youd youll hes shes its were theyre theyve weve wed well lets thats whats whos heres theres
  dont doesnt didnt cant couldnt wont wouldnt shouldnt isnt arent wasnt werent havent hasnt hadnt aint gonna wanna gotta
  be am is are was were been being have has had having do does did done doing will would shall should can could may
  might must ought need needs dare
  get got gotten go goes went gone come came make made take took taken give gave given know knew known think thought
  say said tell told see saw seen look find found want use work call try ask feel felt leave left put mean meant keep
  kept let begin began begun seem help show showed shown hear heard play run ran move live believe bring brought
  happen write wrote written sit sat stand stood lose lost pay paid meet met include continue set learn learnt change
  lead led understand watch follow stop create speak spoke spoken read spend spent grow grew grown open walk win won
  offer remember love consider appear buy bought wait serve die send sent expect build built stay fall fell fallen
  cut reach kill remain suggest raise pass sell sold require report decide pull break broke broken drive drove driven
  ride rode eat ate eaten drink drank sleep slept wake woke hold held catch caught teach taught fight fought throw
  threw thrown draw drew drawn fly flew wear wore hang hung hit hurt shut sing sang sink rise rose swim wish hope
  like hate prefer enjoy finish start stop fix add check test push pick picked pack packed plan cook clean wash
  text call email ping message post share post load save sort pop swing drop dropped sign snap hand handle mind
  reckon guess suppose wonder mention agree disagree argue complain laugh cry smile shout yell scream joke
  visit visiting arrive arrived return returned travel fetch collect bake order book cancel
  good great nice fine ok okay sure right wrong new old big small little large long short high low young early late
  first last next previous other another same different own real true false full empty free busy ready done happy sad
  glad sorry tired sick ill well better best worse worst bad hard easy simple quick slow fast soon lot lots bit few
  many much more most less least enough only just even still also too very really quite pretty rather almost already
  always never ever often sometimes usually maybe perhaps probably actually basically literally honestly seriously
  totally definitely certainly obviously clearly apparently finally recently currently now today tonight tomorrow
  yesterday later earlier ago away back home again once twice anyway anyhow somehow everywhere somewhere nowhere
  yes yeah yep yup nope nah hi hey hello thanks thank please cheers bye lol lmao omg btw tbh imo idk brb afk fyi asap
  pls plz thx ty np ah oh uh um hmm wow haha ha yay ugh meh
  thing things stuff way ways time times day days week weeks month months year years hour hours minute minutes second
  seconds morning afternoon evening night weekend today life world people person man woman men women guy guys girl
  girls boy boys baby folks family friend friends mate mates kid kids child children parent parents
  job work office meeting call client clients project projects team boss company business money cash price cost
  house home place room car bus train bike road street town city school uni college shop store cafe pub gym park
  food dinner lunch breakfast coffee tea water beer wine cake pizza
  code bug bugs fix test tests build file files page pages site app apps api server data database repo branch commit
  function method class type value error issue feature design logo button form image images font fonts color colour
  text line lines word words name names number numbers list version change changes update question answer idea point
  part side end start top bottom left right front middle case fact problem reason result example kind sort level
  course hand head face eye eyes door window table desk chair bed floor wall phone laptop screen keyboard mouse
  cat dog pet pets
  mum mom dad mother father wife husband partner son daughter brother sister aunt uncle cousin nan gran grandma grandpa
  north south east west upper lower inner outer main whole half quarter
  monday tuesday wednesday thursday friday saturday sunday mon tue tues wed thu thur thurs fri sat sun
  january february march april may june july august september october november december
  jan feb mar apr jun jul aug sep sept oct nov dec
  zero two three four five six seven eight nine ten eleven twelve twenty hundred thousand million
  bit ton tons couple pair bunch heaps loads load plenty
  sorry pardon mostly mainly partly fully nearly barely hardly
  gift idea ideas map maps cycling football school run
  rly prob probs def defo obvs tho thru cuz coz cos bc ngl smh iirc afaik jk gtg ttyl omw nvm tmrw tmr tomoz rn irl
  aka etc ish kinda sorta dunno gimme lemme cya xx xo ooh aww yikes oops whoops meh welp
  context bday birthday party holiday holidays trip vacation hols break weekend school nursery work
`);

/** Endings a word can carry and still be an ordinary word: "says" is "say", "snapped" is "snap". */
const ENDINGS = ["s", "es", "ed", "d", "ing", "ly", "ies", "ied"];

/** Is w (lower case) an ordinary word, or one with an ordinary ending? */
export function ordinary(w) {
  const x = String(w || "").toLowerCase().replace(/'/g, "");
  if (!x) return true;
  if (COMMON.has(x)) return true;
  for (const e of ENDINGS) {
    if (!x.endsWith(e) || x.length - e.length < 2) continue;
    const b = x.slice(0, -e.length);
    if (COMMON.has(b)) return true;
    if (e === "ies" || e === "ied") { if (COMMON.has(b + "y")) return true; continue; }
    // "snapped" -> "snap", "running" -> "run"; "making" -> "make".
    if ((e === "ed" || e === "ing") && b.length > 2 && b[b.length - 1] === b[b.length - 2] && COMMON.has(b.slice(0, -1))) return true;
    if ((e === "ed" || e === "ing") && COMMON.has(b + "e")) return true;
  }
  // Word-shaped endings few first names have: a verb form.
  if (/(?:ing|ed)$/.test(x) && x.length > 4) return true;
  return false;
}
