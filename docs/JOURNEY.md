# Setting up Vyre

Vyre runs Claude Code on a server you own and puts it on your Mac and your phone. Setup takes
about ten minutes. You need a Mac with Claude Code, and a Linux server you can SSH into (any
small VPS works). Why it works this way is in [ADR 0008](adr/0008-install-journey.md).

## 1. On your Mac

Install Tailscale from <https://tailscale.com/download/mac> and sign in. No account? Sign in with
Google, GitHub, Apple or Microsoft; that makes one, free for personal use. Then:

```
npm i -g vyre
vyre up
```

(Until Vyre is on npm, the first line is `npm i -g https://vyre.run/box/vyre.tgz`.)

`vyre up` asks where Vyre should run. Pick **a server**, and give it the address you SSH to:

```
  Where should Vyre run?
    1  on a server I can SSH to   (recommended)
    2  on this Mac
    3  I already set up a box
  > 1
  server (user@host): alex@203.0.113.4
```

That is the same as typing `vyre box add alex@203.0.113.4`.

## 2. Vyre sets up the server

The Mac looks at the server and tells you what it will change before it changes anything:

```
  alex@203.0.113.4 · Ubuntu 24.04
    will install Docker (get.docker.com)
    will create /srv/vyre and /usr/local/bin/vyre
  Go ahead? [y/N]
```

If the server asks for your sudo password, type it here. Then your browser opens and the
terminal says "Finish in your browser. I'll wait here."

## 3. In the browser

One step a screen. Any step can be skipped and finished later in Settings.

1. **You.** Your name, and a name for your assistant.
2. **Claude Code.** "Sign in with your subscription" opens Claude's sign-in; paste the code it
   shows. Or paste an API key. It goes into Vyre's vault, never into a file.
3. **Tailscale.** "Connect" opens Tailscale's sign-in for the server. Use the same account as
   your Mac.
4. **Your address.** Vyre gets a certificate for `https://vyre.<your-tailnet>.ts.net`. The first
   time, Tailscale needs HTTPS turned on for your tailnet: press **Turn on HTTPS**, flip the
   switch on the page that opens, come back and press **Check again**. The page then moves to
   your new address.
5. **Your history.** Pick earlier Claude Code sessions to make your first project, or skip.
6. **Your devices.** Scan the two codes with your phone: the first installs Tailscale, the second
   opens Vyre. Your Mac is already connected.

## 4. Done

Your assistant says hello on the last screen. Press **Open Vyre**. Back in the terminal, Vyre
opens one more page to make your passkey (Touch ID or your phone), which approves everything on
your box from now on. Then it asks you to approve your Mac in the Deck with it, and shows a code
to check it is the same Mac. Then it ends with:

```
  Vyre is ready.

    your box        https://vyre.<your-tailnet>.ts.net
    your assistant  Juno · in the Capsule and on your phone
    next            vyre      (your projects and threads)
```

Type `vyre` any time for your projects and threads. `vyre up` prints this block again whenever
you want to check.

## Other ways in

- **Already on the server?** `curl -fsSL https://vyre.run/install.sh | sh`, then follow the link
  it prints (it also prints the `ssh -L` line to reach it from your laptop). Afterwards,
  `npm i -g vyre && vyre up` on your Mac finds the box on your tailnet by itself, and asks you to
  approve the Mac in the Deck on your phone.
- **No server?** `vyre up --box` makes this Mac the box. It has to stay awake for your phone to
  reach it.

## Later

| You want to | Run on your Mac |
|---|---|
| update | `vyre box update`, and `npm i -g vyre@latest && vyre up` for the Mac |
| back up | `vyre box backup` (one file, keep it private: it holds your vault) |
| move to a new server | `vyre box move user@newhost` (your address comes with it) |
| remove it | `vyre box remove` (your data stays on the server unless you add `--purge`) |
