// @ts-check
// cards: finds payment and address fields on a page and fills a card or an address into them.
// It is injected into the top frame beside fill.js when a card or address fill is asked for, and
// registered before inline.js so the chooser can tell a card field from a login field.
//
// Why it is built this way:
//   - Detection is pure functions over a field descriptor ({ tag, type, name, id, autocomplete,
//     label, placeholder, maxLength, options }), so it is tested without a browser and reads
//     nothing from the page beyond what a field says about itself. It never reads a value.
//   - The autocomplete attribute wins (cc-number, postal-code and the rest, HTML's own tokens).
//     Without one, English words in the name, id, label and placeholder decide.
//   - Fills go only to fields that are visible, enabled and not read-only, in this document.
//     A payment field in another site's frame (a processor's iframe) is that site's, and is left
//     alone: the worker targets the top frame only.
//   - Values are set through the element's native value setter and followed by input and change
//     events, as fill.js does for passwords. It returns which kinds of field it filled, never a value.

(() => {
  const g = /** @type {any} */ (globalThis);
  if (g.vyreCards) return;

  const CARD_KEYS = ["cc-name", "cc-given-name", "cc-family-name", "cc-number", "cc-exp", "cc-exp-month", "cc-exp-year", "cc-csc", "cc-type"];
  const ADDRESS_KEYS = ["name", "given-name", "family-name", "organization", "street-address", "address-line1", "address-line2",
    "address-level2", "address-level1", "postal-code", "country", "country-name", "tel", "email"];
  const KNOWN = new Set([...CARD_KEYS, ...ADDRESS_KEYS]);
  /** Autocomplete words that say a field is something else: never a card or address field. */
  const OTHER = /^(username|current-password|new-password|one-time-code|bday.*|sex|url|photo|language|impp|transaction-.*|nickname|honorific-.*|additional-name|organization-title|address-line3|address-level3|address-level4|tel-.*|webauthn|off|on)$/;
  const MODIFIER = /^(section-.*|shipping|billing|home|work|mobile|fax|pager)$/;
  const SKIP_TYPES = new Set(["hidden", "submit", "button", "reset", "image", "file", "checkbox", "radio", "range", "color", "search", "date", "datetime-local", "time", "week"]);

  /** Lower case words: camelCase and letter-digit runs split, separators to spaces. @param {string} s */
  const norm = s => String(s || "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/([a-zA-Z])(\d)/g, "$1 $2").toLowerCase()
    .replace(/[_\-.[\]():*#]+/g, " ").replace(/\s*\/\s*/g, "/").replace(/\s+/g, " ").trim();
  /** Letters and digits only, for comparing option words. @param {string} s */
  const flat = s => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");

  /**
   * The field an autocomplete attribute names, "other" when it names something that is not ours,
   * or null when it says nothing useful.
   * @param {string} ac
   */
  function fromAutocomplete(ac) {
    const tokens = String(ac || "").toLowerCase().trim().split(/\s+/).filter(t => t && !MODIFIER.test(t));
    const last = tokens[tokens.length - 1];
    if (!last) return null;
    if (last === "tel" || last === "tel-national") return "tel";
    if (KNOWN.has(last)) return last;
    if (last === "off" || last === "on") return null;
    return OTHER.test(last) ? "other" : null;
  }

  const CARD_CONTEXT = /\b(exp|expir\w*|expiry|card|cc|credit|debit|valid)\b|ccmonth|ccyear|expmonth|expyear/;
  const CARD_RULES = /** @type {[RegExp, string][]} */ ([
    [/\b(cvc|cvv|cvn|csc|cvv 2|cvc 2|security code|securitycode|card verification|verification (code|number|value)|card code)\b/, "cc-csc"],
    [/\b(card ?type|cc ?type|card brand)\b/, "cc-type"],
    [/\b(name on (the )?card|nameoncard|card ?holder( name)?|cardholder( name)?|holder name|cc name|ccname|card name)\b/, "cc-name"],
    [/\b(card ?(number|num|no)|cardnumber|cardnum|cc ?(number|num|no)|ccnum|ccno|credit card( number)?|debit card( number)?|pan)\b/, "cc-number"],
  ]);
  const MONTH_WORD = /\b(month|mm|mon|mo)\b|ccmonth|expmonth/;
  const YEAR_WORD = /\b(year|yy|yyyy|yr)\b|ccyear|expyear/;
  const EXP_WORD = /\b(expir\w*|expiry|exp date|expdate|exp|valid (thru|through|until))\b|\bmm\/yy(yy)?\b|\bmmyy\b/;

  const ADDRESS_RULES = /** @type {[RegExp, string][]} */ ([
    [/\b(e ?mail|email address)\b/, "email"],
    [/\b(phone|telephone|tel|mobile|cell)\b/, "tel"],
    [/\b(zip|zip ?code|zipcode|post ?code|postcode|postal( code)?|postalcode)\b/, "postal-code"],
    [/\b(country|countrycode)\b/, "country"],
    [/\b(city|town|locality|suburb)\b/, "address-level2"],
    [/\b(state|province|region|county|prefecture)\b/, "address-level1"],
    [/\b(address ?(line)? ?2|addr ?2|line 2|apt|apartment|suite|unit|flat)\b/, "address-line2"],
    [/\b(company|organi[sz]ation|business( name)?)\b/, "organization"],
    [/\b(address ?(line)? ?1|addr ?1|line 1|street( address)?|address|addr)\b/, "address-line1"],
    [/\b(first ?name|given ?name|fname|forename)\b/, "given-name"],
    [/\b(last ?name|surname|family ?name|lname)\b/, "family-name"],
  ]);
  const NOT_A_NAME = /\b(user|login|screen|display|nick|file|domain|host|account) ?name\b|username/;

  /**
   * What a field is: one of the autocomplete tokens above, or null.
   * @param {{ tag?: string, type?: string, name?: string, id?: string, autocomplete?: string, label?: string, placeholder?: string, options?: { value: string, text: string }[] | null }} d
   * @returns {string|null}
   */
  function classify(d) {
    const tag = String(d.tag || "").toLowerCase();
    const type = String(d.type || "").toLowerCase();
    if (!["input", "select", "textarea"].includes(tag)) return null;
    if (tag === "input" && SKIP_TYPES.has(type)) return null;
    const ac = fromAutocomplete(d.autocomplete || "");
    if (ac === "other") return null;
    if (ac) return ac;
    const text = norm([d.name, d.id, d.label, d.placeholder].filter(Boolean).join(" "));
    let key = null;
    for (const [re, k] of CARD_RULES) if (re.test(text)) { key = k; break; }
    if (!key && CARD_CONTEXT.test(text)) {
      const month = MONTH_WORD.test(text), year = YEAR_WORD.test(text);
      if (month && !year) key = "cc-exp-month";
      else if (year && !month) key = "cc-exp-year";
      else if (EXP_WORD.test(text)) key = "cc-exp";
    }
    if (!key && EXP_WORD.test(text) && !/\b(date of birth|birth|dob)\b/.test(text)) key = "cc-exp";
    // A password box is a card code at most: sites mask the CVC that way, and nothing else.
    if (type === "password") return key === "cc-csc" ? key : null;
    if (key) return key;
    if (type === "email") return "email";
    if (type === "tel") return "tel";
    for (const [re, k] of ADDRESS_RULES) if (re.test(text)) return k;
    if (/\b(full ?name|fullname|your name|name)\b/.test(text) && !NOT_A_NAME.test(text)) return "name";
    return null;
  }

  // ---- values for a field ---------------------------------------------------------------

  const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

  /** The option for month `mm` in a month select: "07", "7", "July", "Jul", "07 - July". @param {{ value: string, text: string }[]} options @param {string} mm */
  function pickMonth(options, mm) {
    const n = Number(mm);
    if (!(n >= 1 && n <= 12)) return null;
    const name = MONTHS[n - 1];
    /** @param {string} x */
    const is = x => {
      const s = String(x || "").trim();
      if (/^\d{1,2}$/.test(s)) return Number(s) === n;
      const lead = /^(\d{1,2})\s*[-.):\s]/.exec(s);
      if (lead) return Number(lead[1]) === n;
      const f = flat(s);
      return f === name || f === name.slice(0, 3) || (n === 9 && f === "sept");
    };
    const o = options.find(x => x.value !== "" && is(x.value)) || options.find(x => x.value !== "" && is(x.text));
    return o ? o.value : null;
  }

  /** The option for a year in a year select: "2029" or "29". @param {{ value: string, text: string }[]} options @param {string} yyyy */
  function pickYear(options, yyyy) {
    const yy = String(yyyy).slice(-2);
    const is = x => { const s = String(x || "").trim(); return s === String(yyyy) || s === yy; };
    const o = options.find(x => x.value !== "" && is(x.value)) || options.find(x => x.value !== "" && is(x.text));
    return o ? o.value : null;
  }

  /** An option whose value or text is `v`, ignoring case and punctuation. @param {{ value: string, text: string }[]} options @param {string} v */
  function pickOption(options, v) {
    const want = flat(v);
    if (!want) return null;
    const o = options.find(x => x.value !== "" && flat(x.value) === want) || options.find(x => x.value !== "" && flat(x.text) === want);
    return o ? o.value : null;
  }

  /** ISO 3166 codes with English names and the other names people and forms use. */
  const COUNTRIES = /** @type {[string, ...string[]][]} */ ([
    ["US", "United States", "United States of America", "USA", "America"], ["GB", "United Kingdom", "UK", "Great Britain", "Britain", "GBR", "England"],
    ["CA", "Canada", "CAN"], ["AU", "Australia", "AUS"], ["NZ", "New Zealand"], ["IE", "Ireland"], ["DE", "Germany", "Deutschland", "DEU"],
    ["FR", "France", "FRA"], ["ES", "Spain", "Espana"], ["IT", "Italy", "Italia"], ["PT", "Portugal"], ["NL", "Netherlands", "The Netherlands", "Holland"],
    ["BE", "Belgium"], ["LU", "Luxembourg"], ["CH", "Switzerland"], ["AT", "Austria"], ["DK", "Denmark"], ["SE", "Sweden"], ["NO", "Norway"],
    ["FI", "Finland"], ["IS", "Iceland"], ["PL", "Poland"], ["CZ", "Czechia", "Czech Republic"], ["SK", "Slovakia"], ["HU", "Hungary"],
    ["RO", "Romania"], ["BG", "Bulgaria"], ["GR", "Greece"], ["HR", "Croatia"], ["SI", "Slovenia"], ["EE", "Estonia"], ["LV", "Latvia"],
    ["LT", "Lithuania"], ["UA", "Ukraine"], ["TR", "Turkey", "Turkiye"], ["IL", "Israel"], ["AE", "United Arab Emirates", "UAE"],
    ["SA", "Saudi Arabia"], ["QA", "Qatar"], ["EG", "Egypt"], ["MA", "Morocco"], ["NG", "Nigeria"], ["KE", "Kenya"], ["ZA", "South Africa"],
    ["IN", "India"], ["PK", "Pakistan"], ["LK", "Sri Lanka"], ["BD", "Bangladesh"], ["CN", "China"], ["HK", "Hong Kong"], ["TW", "Taiwan"],
    ["JP", "Japan"], ["KR", "South Korea", "Korea, Republic of", "Republic of Korea", "Korea"], ["SG", "Singapore"], ["MY", "Malaysia"],
    ["TH", "Thailand"], ["VN", "Vietnam", "Viet Nam"], ["PH", "Philippines"], ["ID", "Indonesia"], ["MX", "Mexico"], ["BR", "Brazil", "Brasil"],
    ["AR", "Argentina"], ["CL", "Chile"], ["CO", "Colombia"], ["PE", "Peru"],
  ]);

  /** A country option for a stored country, by ISO code or by name. @param {{ value: string, text: string }[]} options @param {string} country */
  function pickCountry(options, country) {
    const c = flat(country);
    if (!c) return null;
    const row = COUNTRIES.find(r => r.some(x => flat(x) === c));
    const names = new Set(row ? row.map(flat) : [c]);
    const code = row ? flat(row[0]) : null;
    const o = (code && options.find(x => flat(x.value) === code))
      || options.find(x => x.value !== "" && names.has(flat(x.value)))
      || options.find(x => x.value !== "" && names.has(flat(x.text)));
    return o ? o.value : null;
  }

  /** The card's brand from its number, as forms name it. @param {string} number */
  function brandOf(number) {
    const n = String(number || "").replace(/\D/g, "");
    if (/^4/.test(n)) return ["Visa", "visa"];
    if (/^(5[1-5]|2[2-7])/.test(n)) return ["Mastercard", "mastercard", "master card", "mc"];
    if (/^3[47]/.test(n)) return ["American Express", "amex", "americanexpress"];
    if (/^(6011|65|64[4-9])/.test(n)) return ["Discover", "discover"];
    return null;
  }

  /** "Alex Harlow" to ["Alex", "Harlow"]; one word is a given name. @param {string} full */
  function splitName(full) {
    const w = String(full || "").trim().split(/\s+/).filter(Boolean);
    if (w.length < 2) return [w[0] || "", ""];
    return [w.slice(0, -1).join(" "), w[w.length - 1]];
  }

  /**
   * The value one field gets from a card, or null to leave it.
   * @param {string} key @param {any} d @param {any} c { holder, number, expiry, exp_month, exp_year, cvv }
   */
  function cardValue(key, d, c) {
    const select = d.tag === "select", options = d.options || [];
    const hint = norm(`${d.placeholder || ""} ${d.label || ""}`);
    const mm = c.exp_month || "", yyyy = c.exp_year || "", yy = yyyy.slice(-2);
    switch (key) {
      case "cc-name": return c.holder || null;
      case "cc-given-name": return splitName(c.holder)[0] || null;
      case "cc-family-name": return splitName(c.holder)[1] || null;
      case "cc-number": return c.number ? String(c.number).replace(/[\s-]/g, "") : null;
      case "cc-csc": return c.cvv || null;
      case "cc-exp-month": return !mm ? null : select ? pickMonth(options, mm) : mm;
      case "cc-exp-year": {
        if (!yyyy) return null;
        if (select) return pickYear(options, yyyy);
        return d.maxLength === 2 || (/\byy\b/.test(hint) && !/yyyy/.test(hint)) ? yy : yyyy;
      }
      case "cc-exp": {
        if (!mm || !yyyy) return c.expiry || null;
        if (select) return pickOption(options, `${mm}/${yy}`) ?? pickOption(options, `${mm}/${yyyy}`);
        if (/yyyy/.test(hint) || d.maxLength === 7) return `${mm}/${yyyy}`;
        if (d.maxLength === 4 || (/mmyy/.test(hint.replace(/\s/g, "")) && !/\//.test(hint))) return `${mm}${yy}`;
        return `${mm}/${yy}`;
      }
      case "cc-type": {
        const b = brandOf(c.number);
        if (!b) return null;
        if (!select) return b[0];
        const o = options.find(x => x.value !== "" && b.some(w => flat(x.value) === flat(w) || flat(x.text) === flat(w)));
        return o ? o.value : null;
      }
      default: return null;
    }
  }

  /**
   * The value one field gets from an address, or null to leave it.
   * @param {string} key @param {any} d @param {any} a { name, company, line1, line2, city, region, postal, country, phone, email }
   */
  function addressValue(key, d, a) {
    const select = d.tag === "select", options = d.options || [];
    const text = v => (!v ? null : select ? pickOption(options, v) : v);
    switch (key) {
      case "name": return text(a.name);
      case "given-name": return text(splitName(a.name)[0]);
      case "family-name": return text(splitName(a.name)[1]);
      case "organization": return text(a.company);
      case "street-address": return a.line1 ? [a.line1, a.line2].filter(Boolean).join(d.tag === "textarea" ? "\n" : ", ") : null;
      case "address-line1": return text(a.line1);
      case "address-line2": return text(a.line2);
      case "address-level2": return text(a.city);
      case "address-level1": return text(a.region);
      case "postal-code": return text(a.postal);
      case "country": case "country-name": return !a.country ? null : select ? pickCountry(options, a.country) : a.country;
      case "tel": return text(a.phone);
      case "email": return text(a.email);
      default: return null;
    }
  }

  /**
   * What to put where: for classified fields (each with its `key`), the first field of each key
   * that has a value. Pure.
   * @param {any[]} fields descriptors with `key` @param {"card"|"address"} kind @param {any} data
   * @returns {{ i: number, key: string, value: string }[]}
   */
  function plan(fields, kind, data) {
    const want = new Set(kind === "card" ? CARD_KEYS : ADDRESS_KEYS);
    const done = new Set();
    /** @type {{ i: number, key: string, value: string }[]} */
    const out = [];
    fields.forEach((d, i) => {
      if (!d.key || !want.has(d.key) || done.has(d.key)) return;
      const v = kind === "card" ? cardValue(d.key, d, data) : addressValue(d.key, d, data);
      if (v === null || v === undefined || v === "") return;
      done.add(d.key);
      out.push({ i, key: d.key, value: String(v) });
    });
    return out;
  }

  const isCardKey = k => CARD_KEYS.includes(k);
  const isAddressKey = k => ADDRESS_KEYS.includes(k);

  // ---- the page ---------------------------------------------------------------------------

  /** What a field says about itself: attributes and label text, never its value. @param {any} el */
  function describe(el) {
    const attr = n => (el.getAttribute && el.getAttribute(n)) || "";
    const labels = el.labels ? [...el.labels].map(l => l.textContent || "") : [];
    const by = attr("aria-labelledby").split(/\s+/).filter(Boolean)
      .map(id => { const x = typeof document !== "undefined" ? document.getElementById(id) : null; return x ? x.textContent || "" : ""; });
    const tag = String(el.tagName || "").toLowerCase();
    return {
      tag, type: tag === "input" ? String(attr("type") || el.type || "text").toLowerCase() : tag,
      name: String(el.name || attr("name") || ""), id: String(el.id || ""), autocomplete: attr("autocomplete"),
      label: [...labels, attr("aria-label"), ...by].join(" ").replace(/\s+/g, " ").trim().slice(0, 200),
      placeholder: attr("placeholder"), maxLength: typeof el.maxLength === "number" && el.maxLength > 0 ? el.maxLength : null,
      options: tag === "select" ? [...el.options].map(o => ({ value: String(o.value), text: String(o.textContent || "").trim() })) : null,
    };
  }

  /** @param {any} el */
  const usable = el => el.type !== "hidden" && !el.disabled && !el.readOnly && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";

  /** @param {any} el @param {string} v */
  function put(el, v) {
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const set = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    el.focus();
    if (set) set.call(el, v); else el.value = v;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  /** @param {"card"|"address"} kind @param {any} c the item's fields and the origin they were fetched for */
  function fillWith(kind, c) {
    if (!c || location.origin !== c.origin) return { filled: [], why: "the page changed; try again" };
    const want = kind === "card" ? isCardKey : isAddressKey;
    const found = [...document.querySelectorAll("input, select, textarea")].filter(usable)
      .map(el => { const d = describe(el); return { el, d: { ...d, key: classify(d) } }; })
      .filter(x => x.d.key && want(x.d.key));
    if (!found.length) return { filled: [], why: kind === "card" ? "no card fields on this page" : "no address fields on this page" };
    // The form the person was in (the inline chooser's field), else the first one with such fields.
    const anchor = g.vyreCardAnchor;
    g.vyreCardAnchor = null;
    const form = (anchor && anchor.isConnected && anchor.form) || found[0].el.form || null;
    const scoped = form ? found.filter(x => x.el.form === form) : found;
    const steps = plan(scoped.map(x => x.d), kind, c);
    for (const s of steps) put(scoped[s.i].el, s.value);
    return { filled: steps.map(s => s.key), why: steps.length ? null : "nothing on this page takes these fields" };
  }

  g.vyreCards = { classify, describe, plan, pickMonth, pickYear, pickOption, pickCountry, brandOf, splitName, isCardKey, isAddressKey };
  g.vyreFillCard = c => fillWith("card", c);
  g.vyreFillAddress = c => fillWith("address", c);
})();
