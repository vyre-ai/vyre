# Vyre on DigitalOcean: the 1-Click image

A person rents a droplet from the Marketplace and Vyre installs itself. The image is Ubuntu 24.04 with Docker and one first-boot unit.
It does not carry Vyre: on first boot `vyre-firstboot.sh` runs `curl -fsSL https://vyre.run/i | sh -s -- --yes`, the same signed installer,
so a new droplet always gets the newest release and the image never goes stale.

## Build it (needs the user's yes, a few cents of droplet time)

```sh
git clone https://github.com/digitalocean/marketplace-partners
cd deploy/digitalocean
DIGITALOCEAN_API_TOKEN=... packer build vyre-marketplace.json   # the build droplet is tagged vyre-test and destroyed by packer
```

`img_check.sh` must pass (no password, no keys, no history, no pending security updates, cloud-init present, no DigitalOcean agent). The
template runs DigitalOcean's `cleanup.sh` then `img_check.sh` as its last steps, so a failing image is never saved.

## List it

DigitalOcean's vendor process: apply as a vendor, then submit the snapshot and the listing (description, logo, getting-started text, support
contact) in the Vendor Portal. A submitted listing is locked until DigitalOcean's review finishes. The listing has to say that DigitalOcean
does not build or support the software. That application is the user's to make, with their DigitalOcean account.

## Open before it ships

- After first boot the person finishes at https://vyre.run/setup, but that page starts from an install line that carries a setup code. A
  droplet that installed itself has no code, so it needs a way to be adopted from the page (a code the droplet prints in its login message,
  or a link the page can claim). That needs the relay's progress and claim path, which belongs to tailnet and app-design.
- Until then the login message tells the person to open vyre.run/setup, and a plain install prints the box's own local link as `install.sh` does.
