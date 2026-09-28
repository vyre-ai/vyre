# rc-smoke step 6, sourced by rc-smoke.sh: a mail account added the way a person adds one
# (vault.connect, an IMAP/SMTP env-set granted to mail), then mail.send, which must be held at the
# Gate. mail.send only holds (it opens no connection and reads no value), so the hosts are made up
# and no mail server runs. Needs vault.connect (vault-next) and mail (connectors). vault.connect is
# person-only: the smoke checks it is refused with no proof, then proves it with a device key
# (person.mjs) the way a paired phone does.
if ! has vault.connect; then
  skip "6 mail: mail.send is here but vault.connect is not, so no account can be added"
else
  acct_in='{"module":"mail","need":"imap","label":"northwind-orders","fields":{"imap_host":"imap.northwind-bakery.example","imap_port":"993","smtp_host":"smtp.northwind-bakery.example","smtp_port":"465","username":"orders@northwind-bakery.example","password":"not-a-real-password-rc1","security":"tls"}}'
  # vault.connect is the person's own action: with no proof it must be refused, never added.
  r=$(vc vault.connect "$acct_in")
  if echo "$r" | grep -q 'presence_required\|no_terminal'; then
    pass "6 mail: vault.connect with no proof is refused ($(echo "$r" | grep -o 'presence_required\|no_terminal' | head -1))"
  else fail "6 mail: vault.connect with no proof was not refused: $(echo "$r" | short)"; fi
  # Then as a paired phone would: one device-key proof over this exact call (person.mjs).
  r=$("$RC_DOCKER" exec -u vyre "$C" node /opt/rc/person.mjs vault.connect "$acct_in" 2>&1)
  if echo "$r" | grep -q '"error"\|presence_required\|denied\|bad_input'; then
    fail "6 mail: vault.connect did not add the account: $(echo "$r" | short)"
  else
    acct=$(vc mail.accounts '{}' | j '((Array.isArray(d) ? d : d.accounts) || []).find(a => a.adapter === "imap")?.account || ""')
    if [ -z "$acct" ] || [ "$acct" = __notjson__ ]; then
      fail "6 mail: mail.accounts does not list the new IMAP account"
    else
      pass "6 mail: the IMAP account is added (vault.connect, device proof) and listed ($acct)"
      r=$(vc mail.send "{\"account\":\"$acct\",\"to\":\"dana@northwind-bakery.example\",\"subject\":\"Order 1042\",\"body\":\"Your sourdough order is ready for pickup.\"}")
      if [ "$(echo "$r" | A="$acct" j 'Boolean(d.held) && d.via === "mail:" + process.env.A')" = true ]; then
        pass "6 mail: mail.send is held, not sent (via mail:$acct)"
      else fail "6 mail: mail.send was not held: $(echo "$r" | short)"; fi
      # gate.held lists held items only; each is a brief with no state field of its own.
      [ "$(vc gate.held '{}' | A="$acct" j '((Array.isArray(d) ? d : d.items) || []).some(i => i.via === "mail:" + process.env.A)')" = true ] \
        && pass "6 mail: gate.held lists it, waiting for the person" || fail "6 mail: gate.held does not list the held mail"
      case "$(vc vault.list '{}')" in *not-a-real-password-rc1*) fail "6 mail: the password shows in vault.list" ;; *) pass "6 mail: the password never comes back" ;; esac
    fi
  fi
fi
