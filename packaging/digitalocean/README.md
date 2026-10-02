# Vyre on the DigitalOcean Marketplace

The image, the first-boot installer and the listing text for a one-click Vyre Droplet. Nothing here submits anything: the user decides when.

## What the image is

Ubuntu 24.04 LTS with ufw on (SSH only), unattended security updates and Docker. It does not bake in a Vyre release. On a new Droplet's first boot, cloud-init runs `files/vyre-firstboot`, which downloads `SHA256SUMS` and `SHA256SUMS.sig` from vyre.run, checks the signature with the Vyre release key built into the image, checks every file the installer needs against the signed list, and then runs the installer from those checked copies. A bad signature or hash installs nothing and says why in the login banner. So a Droplet always gets the newest release, and never an unverified one.

## Files

- `vyre.pkr.hcl`: the Packer template (DigitalOcean builder, smallest size).
- `scripts/`: base and firewall, Docker, the Vyre files, and DigitalOcean's own `cleanup.sh` and `img_check.sh` (pinned to a commit and checked by sha256 before they run).
- `files/`: the first-boot installer, the per-instance hook, the release key (public), the login banner.
- `listing.md`: the Vendor Portal text, with the facts to re-check before each submission.
- `../../test/do-firstboot.test.js`: the first boot against a fake signed release (good, wrong key, tampered file, missing file, unreachable).

## Build (needs the vendor account's token)

```sh
cd packaging/digitalocean
DIGITALOCEAN_TOKEN=<token> packer init .
DIGITALOCEAN_TOKEN=<token> packer build -var version=0.2.2 .
```

It makes a snapshot in the account and runs DigitalOcean's `img_check.sh` before the snapshot is taken, so a snapshot that DigitalOcean would reject is never made. The version is only a label.

## Submit (a deliberate, separate step; the user says go)

1. Apply at https://marketplace.digitalocean.com/vendors, get the listing form and a Vendor Portal login (cloud.digitalocean.com/vendorportal). They may reject for any reason.
2. In the Vendor Portal, pick the snapshot, paste `listing.md`, submit for review. Review time is not published.
3. Ask one-clicks-team@digitalocean.com two things first: whether a first-boot script may download software (the guidelines say to pre-load what the image needs and do not say), and whether a free listing needs the tax and bank forms.
4. Updating the image is a new pending review through the Vendor Portal or API; plan releases of the IMAGE (rarely) apart from releases of VYRE (every time, at first boot).

## What the vendor terms put on us

Support is ours. Security patches must be prompt (unattended upgrades is on; rebuild the image when Ubuntu or Docker change in a way that matters). A breach is reported to DigitalOcean within 8 hours. They may remove the listing at any time; either side may end on 90 days' notice.

## Not yet proven

The full path on a real Droplet: Packer build, `img_check.sh`, a fresh Droplet's first boot installing a real signed release end to end. The first-boot logic is tested against a fake signed site; the real run needs the vendor account and the first signed release at vyre.run/box/ (`SHA256SUMS.sig` is produced by the release workflow).
