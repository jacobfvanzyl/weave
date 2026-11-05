# The bridge Pi

Set up 2026-11-04. An experiment, not yet part of weave: no WVE issue, and nothing in the repository depends on it. Not to be confused with `weave mcp-bridge`, the Host MCP server's bridge.

## Intent

The bridge Pi is a computer that sits next to real hardware so the person's agents can act on it: flash and debug microcontrollers, watch serial consoles, power-cycle USB devices, and debug networks. It travels with the person and is reached over their tailnet wherever it is.

## How agents reach it

Through Rex, not through an MCP server. The Pi runs a Rex server that the person's Rex hosts list as `bridge`, so an agent with a shell uses the rex skill as it would locally: `rex -S bridge new`, `run --wait`, `capture`, `send`. Terminals persist between commands, which suits long-running jobs like an OpenOCD server, a serial monitor or a packet capture, and the person can watch them and take over from the Rex app.

Files go over Tailscale SSH instead, with rsync, logged in as the same `bridge` account. That's about 15 times faster than going through Rex, and an interrupted copy picks up where it stopped. SSH is only for files; commands still go through Rex, where the person can watch them.

Two other options were weighed and set aside for now:

- **A shell exposed as an MCP tool over SSH.** It runs one command at a time and nobody can watch.
- **A weave Host on the Pi**, reached through the Dispatcher (ADR 0029). That fits when an agent should run on the device itself, with its own thread and policy. It may come later.

## What's on it

- **System:** a Raspberry Pi 5 with 8 GB, running Raspberry Pi OS Lite 64-bit (Debian 13 trixie), from an SD card.
- **Network access:** Tailscale, with Tailscale SSH and Tailscale Serve. Rex's login server sits behind Serve and identifies callers by their Tailscale login, set up as on the person's homelab server. Superlogical's apt repository supplies Rex, pinned, because Debian has an unrelated `rex` package.
- **Accounts:**
  - `bridge` is where Rex lands by default. It has the hardware groups (serial, USB, GPIO, I²C, SPI, packet capture) and no `sudo`.
  - `admin` is the person's account, with `sudo`. Rex gives it only when asked for by name.
  - Over the network, SSH accepts keys and Tailscale SSH only, never passwords.
- **Tools:**
  - flashing and debugging: OpenOCD, probe-rs, picotool, esptool, dfu-util, avrdude, gdb-multiarch;
  - serial consoles: tio, picocom;
  - network: tshark, tcpdump, nmap, iperf3, mtr, arp-scan, ethtool, iw;
  - USB hub power: uhubctl.
- **Wi-Fi:** NetworkManager keeps the home network and the person's iPhone hotspot, with the hotspot at the lowest priority. Both retry forever. While travelling, the Pi joins the hotspot, which puts it on the tailnet, and the person adds the local network from there with `nmcli`.

## Rules for agents

- **Work as `bridge`.** Anything that needs `admin` or `sudo` is the person's to do or approve.
- **Don't take down `wlan0`** or change the Wi-Fi it uses. It's the Pi's way onto the tailnet, and losing it means someone has to fix the Pi by hand. Networks under test belong on separate adapters.
- **Keep credentials out of this repository**: passwords, Wi-Fi keys, tailnet names and account mappings.

## Open questions

- Should `bridge` be allowed to change NetworkManager settings? Debugging networks over USB adapters would need it, but so could dropping the uplink.
- Should the tailnet's SSH policy send Tailscale SSH to `bridge` rather than `admin`, since agents on the person's computer share their identity?
- Hotel captive portals, and whether the weave app should manage the Pi's Wi-Fi over Bluetooth: see `docs/research/ble-wifi-provisioning-for-a-bridge-pi.md`. For now the answer is the hotspot.
- `uhubctl` needs a udev rule before `bridge` can switch a hub's ports. Moving from the SD card to an SSD is also still to do.
