// The Vyre DigitalOcean Marketplace image (Ubuntu 24.04 LTS). Build with:
//   DIGITALOCEAN_TOKEN=<token of the vendor account> packer init . && packer build -var version=<release> .
// It makes a snapshot in that account; submitting it in the Vendor Portal is a separate, deliberate step
// (README.md). Nothing here publishes anything.

packer {
  required_plugins {
    digitalocean = {
      version = ">= 1.1.1"
      source  = "github.com/digitalocean/digitalocean"
    }
  }
}

variable "do_token" {
  type      = string
  sensitive = true
  default   = env("DIGITALOCEAN_TOKEN")
}

variable "version" {
  type        = string
  default     = "dev"
  description = "A label for the snapshot name. The image installs the LATEST release at first boot whatever this says."
}

variable "bake" {
  type        = bool
  default     = false
  description = "true: stage the latest release INTO the image (the fallback if DigitalOcean does not allow a first-boot download). false: the first boot installs the latest."
}

variable "region" {
  type    = string
  default = "nyc3"
}

source "digitalocean" "vyre" {
  api_token     = var.do_token
  image         = "ubuntu-24-04-x64"
  region        = var.region
  // The smallest size: a disk cannot be shrunk, so a small base lets people pick any plan.
  size          = "s-1vcpu-1gb"
  ssh_username  = "root"
  snapshot_name = "vyre-${var.version}${var.bake ? "-baked" : ""}-{{timestamp}}"
  // No monitoring agent, no IPv6, no private networking on the build droplet (DigitalOcean's image check flags them).
  monitoring    = false
  ipv6          = false
  private_networking = false
}

build {
  sources = ["source.digitalocean.vyre"]

  provisioner "shell" {
    inline = ["cloud-init status --wait"]
  }

  provisioner "file" {
    source      = "files/"
    destination = "/tmp/vyre-files/"
  }

  provisioner "shell" {
    environment_vars = ["DEBIAN_FRONTEND=noninteractive", "BAKE=${var.bake ? 1 : 0}"]
    scripts = [
      "scripts/010-base.sh",
      "scripts/020-docker.sh",
      "scripts/030-vyre.sh",
      "scripts/035-bake-release.sh",
      "scripts/090-cleanup-and-check.sh",
    ]
  }
}
