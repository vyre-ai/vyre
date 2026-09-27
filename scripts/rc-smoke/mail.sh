# rc-smoke step 6, sourced by rc-smoke.sh: a mail account added the way a person adds one
# (vault.connect, an IMAP/SMTP env-set granted to mail), then mail.send, which must be held at the
# Gate. mail.send only holds (it opens no connection and reads no value), so the hosts are made up
# and no mail server runs. Needs vault.connect (vault-next) and mail (connectors).
if ! has vault.connect; then
  skip "6 mail: mail.send is here but vault.connect is not, so no account can be added"
else
  r=$(vc vault.connect '{"module":"mail","need":"imap","label":"Northwind orders","fields":{"imap_host":"imap.northwind-bakery.example","imap_port":"993","smtp_host":"smtp.northwind-bakery.example","smtp_port":"465","username":"orders@northwind-bakery.example","password":"not-a-real-password-rc1","security":"tls"}}')
  if echo "$r" | grep -q '"error"\|presence_required\|denied\|bad_input'; then
    fail "6 mail: vault.connect did not add the account: $(echo "$r" | short)"
  else
    acct=$(vc mail.accounts '{}' | j '((Array.isArray(d) ? d : d.accounts) || []).find(a => a.adapter === "imap")?.account || ""')
    if [ -z "$acct" ] || [ "$acct" = __notjson__ ]; then
      fail "6 mail: mail.accounts does not list the new IMAP account"
    else
      pass "6 mail: the IMAP account is added (vault.connect) and listed ($acct)"
      r=$(vc mail.send "{\"account\":\"$acct\",\"to\":\"dana@northwind-bakery.example\",\"subject\":\"Order 1042\",\"body\":\"Your sourdough order is ready for pickup.\"}")
      if [ "$(echo "$r" | A="$acct" j 'Boolean(d.held) && d.via === "mail:" + process.env.A')" = true ]; then
        pass "6 mail: mail.send is held, not sent (via mail:$acct)"
      else fail "6 mail: mail.send was not held: $(echo "$r" | short)"; fi
      [ "$(vc gate.held '{}' | A="$acct" j '((Array.isArray(d) ? d : d.items) || []).some(i => i.via === "mail:" + process.env.A && i.state === "held")')" = true ] \
        && pass "6 mail: gate.held lists it, waiting for the person" || fail "6 mail: gate.held does not list the held mail"
      case "$(vc vault.list '{}')" in *not-a-real-password-rc1*) fail "6 mail: the password shows in vault.list" ;; *) pass "6 mail: the password never comes back" ;; esac
    fi
  fi
fi
