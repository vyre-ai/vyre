# The assembled copy of an HTML page, as Cloudflare serves it: the edge removes our own <!--email_off--> and <!--/email_off--> comments (and nothing else of ours) after it has left the text between them alone.
# scripts/assemble-site.sh --check strips exactly these two comments from the ASSEMBLED page before comparing it with the served one; the served bytes are never touched, so any other difference still fails.
s/<!--email_off-->//g
s#<!--/email_off-->##g
