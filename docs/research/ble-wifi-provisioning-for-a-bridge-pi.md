# Wi-Fi over Bluetooth for a bridge Pi

Research snapshot, 2026-11-04. All sources were read on 2026-11-04. They are primary sources only: the Improv Wi-Fi spec; Espressif's ESP-IDF documentation; the source, READMEs, tags and commit history of each project on GitHub (read through the GitHub API); BlueZ's D-Bus documentation and source, and the Linux kernel's `net/bluetooth/smp.c`; NetworkManager's API documentation; Debian's and Raspberry Pi's package archives for trixie; Raspberry Pi's documentation, news posts, tutorials and release notes; Apple's developer documentation (read as JSON from `developer.apple.com/tutorials/data/documentation/...`, since its HTML is rendered by script), the Accessory Design Guidelines (2026-10-30 edition), the Matter OTA guide, WWDC sessions, Apple Support articles and Apple engineers' replies on the developer forums; the Matter SDK's build guide; GL.iNet's router documentation; and RFC 8910. Section 7.1 reads the app at the working tree's `HEAD` (`f919e6ce`). Nothing was built, installed or run on a device. Section 11 lists what only a device can settle.

The question is whether an existing route lets the weave app on an iPhone manage a headless Raspberry Pi 5's Wi-Fi over Bluetooth while the person travels. The Pi runs Raspberry Pi OS Lite 64-bit (trixie, NetworkManager) and is a bridge device for the person's agents, reached over the tailnet through a Rex terminal server. Managing means scanning, joining, forgetting and ordering saved networks, and seeing the current connection and its IP. Bluetooth only has to cover the time when the Pi has no network. Once it's on Wi-Fi, the tailnet takes over.

## 1. In brief

- **Raspberry Pi has nothing official for this.** Its routes are to pre-seed networks before first boot (Imager, which now writes cloud-init's `network-config`), to run `nmcli` in a shell, or, since the trixie images of 2025-10-20, to use USB gadget mode (`rpi-usb-gadget`). Raspberry Pi Connect needs a network to begin with. Nothing in the docs, the `raspberrypi` GitHub organisation or the OS release notes covers Wi-Fi setup over BLE (section 2).
- **Improv BLE is too small for this.** It sends one SSID and password, and since revision 2.2 it can scan. It can't list saved networks, forget one or set priorities, and its only protection is an optional "press a button" authorization. Credentials go over the air in plain text unless the link happens to be encrypted. On Linux it exists as a Python library (pyImprov) and a 2022 prototype (section 3).
- **Espressif's protocol has the security model, but no Linux device side.** Security 2 is SRP6a with AES-256-GCM, and `ESPProvision` is a maintained Swift library. But it provisions a single network, and I found no implementation of the device side for Linux (section 4).
- **The Linux BLE daemons are thin on security.** nymea-networkmanager is maintained (1.16.2, 2026-10-25, GPL-3.0). It scans, connects, disconnects and reports the connection and IP, but its characteristics demand no encryption and no authentication, and it can't forget networks. btwifiset (MIT, last commit 2026-02-21) can forget, and adds encryption at the application layer with a key derived from a password whose default is the hostname. Neither sets priorities. wifi-connect and Comitup work through an access point and a captive portal, not BLE (section 5).
- **Trixie has all the building blocks.** It ships BlueZ 5.82 and NetworkManager 1.52.1, both rebuilt by Raspberry Pi. BlueZ's `GattManager1` and `LEAdvertisingManager1` serve GATT and advertisements over D-Bus, with security flags per characteristic down to "authenticated LE Secure Connections". NetworkManager's D-Bus API covers scanning, adding, deleting, priorities, addresses and portal detection (section 6).
- **On iOS it has to be BLE, and the app can't start pairing.** Classic SPP/RFCOMM needs MFi (External Accessory), and so do WAC, Wi-Fi Information Sharing and out-of-band pairing. iOS pairs when the app touches a protected characteristic, and the bond belongs to the system (section 7).
- **AccessorySetupKit suits a non-MFi BLE accessory, but it doesn't share Wi-Fi.** On iOS 18 and later it replaces the Bluetooth permission prompt with a system picker that also runs the pairing UI. Apple's engineers say it carries no Wi-Fi credentials, and that communication stays with Core Bluetooth and `NEHotspotConfiguration`. MatterSupport can hand a chosen network to a device, but that needs a Matter stack on the Pi and gives one network per commissioning (section 7.5).
- **A Personal Hotspot profile needs no code at all.** If the Pi has the iPhone's Personal Hotspot saved as a network, it can reach the tailnet from anywhere the phone has cellular data, and `nmcli` over Rex does the rest. Apple says to "Stay on this screen until the other device has connected", and Maximize Compatibility restricts the hotspot to 2.4 GHz and WPA2 (section 8.1).
- **Captive portals are the real gap, and BLE doesn't close it.** A portal authorises the device that logs in. The two existing fixes are both from travel routers: the phone logs in *through* the Pi (which needs a second Wi-Fi radio), or the Pi clones the phone's per-network private address. NetworkManager reports a portal only when a connectivity URI is configured, and Debian puts that in an optional package (section 9).
- **Recommendation (section 10):** start with the Personal Hotspot profile, which needs no code. If Bluetooth is still wanted, write a small GATT service of our own in front of NetworkManager rather than adopt Improv or nymea, since neither covers the operations or the security a bridge device needs. Bond once at home, with the passkey relayed over the tailnet, so that every value requires authenticated LE Secure Connections. Keep the Pi unpairable at all other times, and advertise only while it's off the tailnet. In the app, use `@capacitor-community/bluetooth-le` 8.3.0 and keep the protocol in TypeScript. Captive portals need their own decision.

## 2. Raspberry Pi's own offerings

- **Imager and cloud-init.** Trixie images ship cloud-init. Imager 2.0 "now generates cloud-init configuration by default", and a `network-config` file on the boot partition can set up Wi-Fi with `renderer: NetworkManager`. Raspberry Pi says "multiple networks, priority fallback, static IP assignments, VLANs, and more are supported" ([Cloud-init on Raspberry Pi OS](https://www.raspberrypi.com/news/cloud-init-on-raspberry-pi-os/), 2025-11-27). This is set before flashing, not on the road.
- **`nmcli`.** The configuration docs cover finding and joining networks with `nmcli` and priorities with `connection.autoconnect-priority`: the Pi "tries to connect to the in-range network with the highest non-negative priority" ([Configuration](https://www.raspberrypi.com/documentation/computers/configuration.html)). This needs a shell, so a network.
- **USB gadget mode.** "Starting with Raspberry Pi OS Trixie images dated 20.10.2025 and later", `rpi-usb-gadget` is included and Imager can switch it on ([USB gadget mode in Raspberry Pi OS](https://www.raspberrypi.com/news/usb-gadget-mode-in-raspberry-pi-os-ssh-over-usb/), 2026-01-21; [raspberrypi/rpi-usb-gadget](https://github.com/raspberrypi/rpi-usb-gadget), Apache-2.0, v1.0.6, 2025-10-16). See section 8.3.
- **Raspberry Pi Connect** gives a remote shell (`rpi-connect-lite` on Lite) through a browser, relayed when needed ([Connect](https://www.raspberrypi.com/documentation/services/connect.html)). It says nothing about provisioning Wi-Fi, and it needs the Pi online.
- **Nothing for BLE.** The `raspberrypi` GitHub organisation has provisioning tools for manufacturing (`usbboot`, `cmprovision`, `rpi-sb-provisioner`), but nothing for Wi-Fi over BLE. The OS release notes through 2026-10-06 mention Bluetooth only for desktop pairing, panel plugins and bug fixes ([release notes](https://downloads.raspberrypi.com/raspios_lite_arm64/release_notes.txt)).
- **The radio.** The Pi 5 has "Dual-band 802.11ac Wi-Fi" and "Bluetooth 5.0 / Bluetooth Low Energy (BLE)" ([Raspberry Pi 5](https://www.raspberrypi.com/products/raspberry-pi-5/)).
- **Versions.** Raspberry Pi's trixie archive carries `bluez 5.82-1.1+rpt2`, `network-manager 1.52.1-1+rpt4`, `rpi-connect-lite 2.14.0` and `rpi-usb-gadget 1.0.6` ([arm64 Packages](http://archive.raspberrypi.com/debian/dists/trixie/main/binary-arm64/Packages.gz)). Debian's own trixie packages are `bluez 5.82-1.1` ([bluez](https://packages.debian.org/trixie/bluez)) and `network-manager 1.52.1-1` ([network-manager](https://packages.debian.org/trixie/network-manager)).

## 3. Improv Wi-Fi over BLE

### 3.1 The protocol

From the [BLE spec](https://www.improv-wifi.com/ble/):

- Service `00467768-6228-2272-4663-277478268000`, advertised together with service data `4677` (6 bytes: state, capabilities, reserved). It has five characteristics: Current State (`…8001`), Error State (`…8002`), RPC Command (`…8003`), RPC Result (`…8004`) and Capabilities (`…8005`).
- States: Authorization Required, Authorized, Provisioning, Provisioned. "Physical authorization (for example, a button press) is optional", a device without it starts Authorized, and authorization should lapse after about a minute.
- RPCs: Send Wi-Fi settings (`0x01`: SSID and password), Identify, Device Info, Request scanned Wi-Fi networks (`0x04`: SSID, RSSI, auth type), Get/Set Hostname and Get/Set Device Name. Each packet is a command byte, length, data and a one-byte sum checksum, and the client reassembles anything over 20 bytes. A successful provisioning may return a redirect URL, after which "the Improv service stops".
- Revisions: 2.2 added scanning, 2.3 the hostname and 2.4 the device name. The official web SDK added "Improv BLE 2.1/2.2 support" on 2026-10-10 ([improv-wifi/sdk-ble-js](https://github.com/improv-wifi/sdk-ble-js)).
- Scope: "it is not the goal to offer a way for devices to share data or control" ([improv-wifi.com](https://www.improv-wifi.com/)).

What it doesn't have:

- A list of saved networks, a way to forget one, priorities, or a status read with the current SSID and IP. The redirect URL is the only thing returned.
- Encryption or authentication. The spec defines no pairing requirement, so the SSID and password travel as plain characteristic writes. A device can mark the characteristics encrypted and iOS would then pair, but that is outside the spec.

### 3.2 Implementations

| Project | Side | Last release | Last commit | Licence | Notes |
| --- | --- | --- | --- | --- | --- |
| [improv-wifi/sdk-iOS](https://github.com/improv-wifi/sdk-iOS) | iOS client (Swift, SPM) | tag 0.0.6, 2024-07-19 | 2026-01-19 | Apache-2.0 | Official. No UI. |
| [Mimoja/pyImprov](https://github.com/Mimoja/pyImprov) | Device, Python | v0.2.0, 2026-03-25 | 2026-03-25 | LGPL-2.1 | A library. Its example serves GATT through `bless` on BlueZ D-Bus. Joining the network is left to the caller, so there's no NetworkManager glue. |
| [rpardini/improv-wifi-python-nm](https://github.com/rpardini/improv-wifi-python-nm) | Device, BlueZ + NetworkManager | none | 2022-07-11 | none | "early prototype, does not really do anything yet". |

The web SDKs don't help on an iPhone: the demos work "in Google Chrome or Microsoft Edge (but not on your iOS device)" ([improv-wifi.com](https://www.improv-wifi.com/)).

## 4. Espressif provisioning

- **What it is.** "Unified Provisioning" on protocomm, with SoftAP or BLE transports ([ESP-IDF v6.1, Unified Provisioning](https://docs.espressif.com/projects/esp-idf/en/stable/esp32/api-reference/provisioning/provisioning.html)). Wi-Fi and Thread provisioning now live in the `network_provisioning` component, version 1.4.0 ([idf-extra-components/network_provisioning](https://github.com/espressif/idf-extra-components/tree/master/network_provisioning), last changed 2026-10-21).
- **Security.** Security 0 is plain text. Security 1 is "Curve25519-based key exchange, shared key derivation and AES256-CTR", with an optional proof of possession. Security 2 is "SRP6a-based shared key derivation and AES256-GCM", with the salt and verifier made beforehand from a username and password. This is the only protocol surveyed that authenticates both ends with a secret that never crosses the air.
- **Endpoints.** `prov-session`, `prov-scan`, `prov-ctrl`, `prov-config`, `proto-ver` and custom endpoints. On BLE, clients find them by the `0x2901` user description, not by UUID ([v5.4 Wi-Fi provisioning](https://docs.espressif.com/projects/esp-idf/en/v5.4/esp32/api-reference/provisioning/wifi_provisioning.html)).
- **One network.** After a failed attempt, "any further attempts to provide another set of Wi-Fi credentials, are to be rejected" until a reset. Nothing covers several saved networks, forgetting or priorities.
- **iOS.** [espressif/esp-idf-provisioning-ios](https://github.com/espressif/esp-idf-provisioning-ios) (`ESPProvision`): Apache-2.0, last release 3.0.3 on 2025-03-18, last commit 2026-09-16, iOS 13+, SPM or CocoaPods. It supports security 2, Wi-Fi scan lists and custom data.
- **Linux.** I found no device-side implementation of protocomm or the provisioning manager for Linux. `esp_prov` is the desktop client. Adopting this would mean porting the protobuf messages, the SRP6a handshake and the session layer.

## 5. Linux daemons that drive NetworkManager

| Project | How the phone reaches it | Last release / commit | Licence | Covers | Security |
| --- | --- | --- | --- | --- | --- |
| [nymea-networkmanager](https://github.com/nymea/nymea-networkmanager) + [libnymea-networkmanager](https://github.com/nymea/libnymea-networkmanager) | BLE GATT (Qt) | 1.16.2, 2026-10-25 | GPL-3.0-or-later (daemon), LGPL-3.0-or-later (library) | Scan, network list, connect (also hidden), disconnect, current connection with IP, start an AP, enable or disable networking and Wi-Fi | None on the characteristics (below) |
| [BerryLan](https://github.com/nymea/berrylan) (client for the above) | iOS and Android app | 1.0.51, 2024-04-29 | GPL-3.0 | | |
| [btwifiset](https://github.com/nksan/Rpi-SetWiFi-viaBluetooth) + BTBerryWifi app | BLE GATT (Python, BlueZ D-Bus) | no releases, 2026-02-21 | MIT | Scan, known networks, connect, delete, IP | Encryption and a lock at the application layer, keyed from a password (below) |
| [wifi-connect](https://github.com/balena-os/wifi-connect) | The Pi's own AP + captive portal | v4.11.91, 2026-10-22 | Apache-2.0 | Pick a network and enter its passphrase | AP "unprotected" by default, WPA2 passphrase optional |
| [Comitup](https://github.com/davesteele/comitup) | The Pi's own AP + captive portal | v1.47.1, 2026-04-20; 2026-06-15 | GPL-2.0 | Several remembered networks. With two Wi-Fi interfaces, keeps the hotspot up and routes through it | Optional `ap_password` |

Newer projects found but not assessed in depth: [teton-provision](https://github.com/royster57/teton-provision) (MIT, v0.1.0 of 2026-10-08, P-256 ECDH and AES-GCM keyed from a QR label, tested only with Android Chrome), [RaspiProv](https://github.com/prototypeforge/RaspiProv) (MIT, registers a Just Works agent, calls `nmcli`) and [Blynk-Provisioning-Linux](https://github.com/Blynk-Technologies/Blynk-Provisioning-Linux) (MIT, tied to the Blynk app). All three are months or days old with no users to speak of.

Details that matter:

- **nymea.** The daemon starts its BLE server according to a mode: `offline`, `once`, `button` (a GPIO held for 2 s), `always`, `start` (3 minutes after boot) or `dbus`. Messages are compact JSON in 20-byte packets ended by `\n` ([README](https://github.com/nymea/nymea-networkmanager)). Its wireless characteristics are declared with bare `Read`, `Write` and `Notify` properties and no read or write constraints ([wirelessservice.cpp](https://github.com/nymea/libnymea-networkmanager/blob/master/libnymea-networkmanager/bluetooth/wirelessservice.cpp)). So any phone in range can connect while the server is up, and the password crosses unencrypted. A connect creates a NetworkManager profile with `autoconnect` and `autoconnect-retries` 0. There's no forget command, and no priorities.
- **btwifiset.** It sets the adapter's `Pairable` false and serves plain read, write and notify characteristics. It encrypts with ChaCha20-Poly1305 under the SHA-256 of a password ([btcrypto.py](https://github.com/nksan/Rpi-SetWiFi-viaBluetooth/blob/main/working/btcrypto.py)), and the installer suggests the hostname as that password. In the iOS app, encryption, the lock and IP reporting are "extra features … available to supporters". The protocol isn't documented apart from the code. It builds some `nmcli` command lines with unquoted connection names and `shell=True` ([wifiwpa.py](https://github.com/nksan/Rpi-SetWiFi-viaBluetooth/blob/main/working/wifiwpa.py), `nmcli_known_networks`), which is unwelcome in a root service. Its README also warns that on trixie, "rfkill having soft-blocked Bluetooth by default" stops it on some boards.
- **AP-based tools** need the phone to leave its own network and join the Pi's. They also take the Pi's only radio off the upstream network while the AP is up, unless there's a second adapter (Comitup's appliance mode).

## 6. Building blocks on trixie

### 6.1 BlueZ

- **GATT server.** `org.bluez.GattManager1.RegisterApplication(object, dict)` registers a tree of `GattService1`, `GattCharacteristic1` and `GattDescriptor1` objects ([GattManager](https://github.com/bluez/bluez/blob/master/doc/org.bluez.GattManager.rst)). `org.bluez.LEAdvertisingManager1.RegisterAdvertisement` takes an `LEAdvertisement1` with `ServiceUUIDs`, `ServiceData`, `LocalName`, `Timeout`, `MinInterval`/`MaxInterval` and more ([LEAdvertisingManager](https://github.com/bluez/bluez/blob/master/doc/org.bluez.LEAdvertisingManager.rst), [LEAdvertisement](https://github.com/bluez/bluez/blob/master/doc/org.bluez.LEAdvertisement.rst)).
- **Security per characteristic.** The flags are `encrypt-*`, `encrypt-authenticated-*`, `secure-*` and `authorize` ([GattCharacteristic](https://github.com/bluez/bluez/blob/master/doc/org.bluez.GattCharacteristic.rst)). In `check_permissions` ([gatt-server.c](https://github.com/bluez/bluez/blob/master/src/shared/gatt-server.c)), `encrypt` needs security level MEDIUM and answers Insufficient Encryption below it. `encrypt-authenticated` needs HIGH and `secure` needs FIPS, and both answer Insufficient Authentication. In the kernel's SMP, "JUST_WORKS and JUST_CFM result in an unauthenticated key" (MEDIUM), and an LE Secure Connections pairing by any other method is FIPS ([smp.c](https://github.com/torvalds/linux/blob/master/net/bluetooth/smp.c)). So `secure-*` means "bonded with authenticated LE Secure Connections".
- **Pairing control.** `Adapter1.Pairable` "only affects incoming pairing requests", and `PairableTimeout` makes pairable mode expire ([Adapter](https://github.com/bluez/bluez/blob/master/doc/org.bluez.Adapter.rst)). An agent registers with one capability: `DisplayOnly`, `DisplayYesNo`, `KeyboardOnly`, `NoInputNoOutput` or `KeyboardDisplay` ([AgentManager](https://github.com/bluez/bluez/blob/master/doc/org.bluez.AgentManager.rst)). A displayed passkey is random, made by the kernel (`get_random_bytes(...) % 1000000` in smp.c), and handed to the agent's `DisplayPasskey` ([Agent](https://github.com/bluez/bluez/blob/master/doc/org.bluez.Agent.rst)). The agent only displays it, so a headless Pi can't use a fixed passkey printed on a label. `main.conf` has `SecureConnections` (`on` by default, or `only`), `Privacy` (`off` by default), `JustWorksRepairing` (`never` by default) and `AlwaysPairable` ([main.conf](https://github.com/bluez/bluez/blob/master/src/main.conf)).
- **L2CAP.** LE credit-based channels are `BT_MODE_LE_FLOWCTL` sockets ([l2cap-protocol](https://github.com/bluez/bluez/blob/master/doc/l2cap-protocol.rst)). They're relevant to section 9.
- **PAN.** `org.bluez.Network1.Connect("nap")` joins a Network Access Point as PANU ([Network](https://github.com/bluez/bluez/blob/master/doc/org.bluez.Network.rst)).
- **Rust.** [bluez/bluer](https://github.com/bluez/bluer), "the official Rust interface" to BlueZ: GATT servers, advertisements and L2CAP sockets on Tokio. BSD-2-Clause, release 0.17.4 on 2025-06-06, last commit 2026-08-17.
- **An iPhone quirk.** The Matter SDK's Linux guide disables BlueZ's battery plugin (`bluetoothd -E -P battery`), because "iOS devices advertises a battery service via BLE, which requires pairing if accessed". Without that, "the BLE connection will be terminated during the Matter commissioning process" ([Building Matter](https://project-chip.github.io/connectedhomeip-doc/guides/BUILDING.html)).

### 6.2 NetworkManager

- **Scan.** `Device.Wireless.RequestScan(a{sv})`, which takes an `ssids` option, then `GetAllAccessPoints` and `LastScan` ([Device.Wireless](https://networkmanager.dev/docs/api/latest/gdbus-org.freedesktop.NetworkManager.Device.Wireless.html)).
- **Join and add.** `AddAndActivateConnection` and `ActivateConnection`. For the current connection, `PrimaryConnection` ([NetworkManager](https://networkmanager.dev/docs/api/latest/gdbus-org.freedesktop.NetworkManager.html)).
- **Forget and edit.** `Settings.Connection.Delete` and `Update`. `GetSettings` "never includes connection secrets" ([Settings.Connection](https://networkmanager.dev/docs/api/latest/gdbus-org.freedesktop.NetworkManager.Settings.Connection.html)).
- **Order.** `connection.autoconnect-priority`, -999 to 999 and 0 by default ([nm-settings-nmcli](https://networkmanager.dev/docs/api/latest/nm-settings-nmcli.html)).
- **MAC address.** `802-11-wireless.cloned-mac-address` takes `preserve`, `permanent`, `random`, `stable`, `stable-ssid` or an address, and defaults to `preserve` (same page; [NetworkManager.conf](https://networkmanager.dev/docs/api/latest/NetworkManager.conf.html)).
- **Portals.** The `Connectivity` property and `CheckConnectivity()` give `NM_CONNECTIVITY_PORTAL` when "the Internet connection is hijacked by a captive portal gateway" ([nm-dbus-types](https://networkmanager.dev/docs/api/latest/nm-dbus-types.html)). But "if this option [`uri`] is blank or missing, connectivity checking is disabled" ([NetworkManager.conf](https://networkmanager.dev/docs/api/latest/NetworkManager.conf.html)). Debian puts `uri=http://network-test.debian.org/nm` in a separate package, [`network-manager-config-connectivity-debian`](https://packages.debian.org/trixie/network-manager-config-connectivity-debian), which `network-manager` doesn't recommend. I couldn't tell whether the Lite image installs it.

Everything the person wants maps onto these calls, and no surveyed daemon uses all of them.

## 7. The iPhone side

### 7.1 The app today

- Capacitor 8: `@capacitor/core` `^8.3.4` and `capacitor-swift-pm` 8.5.3, with plugins through Swift Package Manager in `ios/App/CapApp-SPM/Package.swift`, which the Capacitor CLI manages. The current plugins are app, clipboard, keyboard, network, preferences and status bar.
- The deployment target is iOS 15.0. The app is scene-based (`SceneDelegate`), with `UIApplicationSupportsMultipleScenes` false.
- Native code goes in as in-app plugins (`CAPPlugin, CAPBridgedPlugin`), which `SceneDelegate` registers with `bridge?.registerPluginInstance(...)`. Examples are `DeviceKeyPlugin`, `NativeTerminalPlugin` and `SurfacePlugin`.
- `Info.plist` has no Bluetooth usage string.
- `DeviceKeyPlugin` already holds a P-256 key per paired Host, in the Secure Enclave where there is one, and signs with ECDSA-SHA256. Section 10.4 reuses it.

### 7.2 `@capacitor-community/bluetooth-le`

- [Repository](https://github.com/capacitor-community/bluetooth-le): MIT. The 8.x line supports Capacitor 8. The latest is 8.3.0, published 2026-08-13, and the last commit is 2026-09-10. Its `Package.swift` targets iOS 15, which matches the app.
- API: `initialize`, `requestDevice` (a device list it draws itself), `requestLEScan`, `connect`, `getServices`, `read`, `write`, `writeWithoutResponse`, `startNotifications`, `getMtu`, `readRssi` and more. `createBond`, `isBonded` and `getBondedDevices` are Android only: "On iOS bonding is handled by the OS." The maximum write is three bytes less than the MTU, so longer messages need framing.
- iOS needs `NSBluetoothAlwaysUsageDescription`, and `bluetooth-central` only for background use.
- It creates its `CBCentralManager` with no restore identifier, so there's no state restoration. It has no AccessorySetupKit support. I found no Capacitor plugin for AccessorySetupKit on npm, only an Expo module.

### 7.3 Core Bluetooth constraints

- "This key is required if your app uses the device's Bluetooth interface" ([NSBluetoothAlwaysUsageDescription](https://developer.apple.com/documentation/bundleresources/information-property-list/nsbluetoothalwaysusagedescription)).
- In the background, scanning needs the `bluetooth-central` mode and explicit service UUIDs, and "the CBCentralManager scan option has no effect" ([scanForPeripherals](https://developer.apple.com/documentation/corebluetooth/cbcentralmanager/scanforperipherals(withservices:options:)), [background modes](https://developer.apple.com/documentation/xcode/configuring-background-execution-modes)). None of that is needed here. The person manages Wi-Fi with the app open.
- State restoration: "In scene-based apps … `launchOptions` is always `nil` on launch", so the app would persist the restore identifier itself ([CBCentralManagerOptionRestoreIdentifierKey](https://developer.apple.com/documentation/corebluetooth/cbcentralmanageroptionrestoreidentifierkey)). This isn't needed for a foreground task either.
- Classic Bluetooth: Core Bluetooth has reached BR/EDR devices since iOS 13, but only through GATT ("transparent use of GATT with the BR/EDR devices", [WWDC19 901](https://developer.apple.com/videos/play/wwdc2019/901/)). The [External Accessory](https://developer.apple.com/documentation/externalaccessory) framework is for "an MFi accessory". iOS's list of Bluetooth profiles has PAN, HID and others but no SPP ([Apple Support HT204387](https://support.apple.com/en-us/HT204387)). So it's BLE GATT or L2CAP ([openL2CAPChannel](https://developer.apple.com/documentation/corebluetooth/cbperipheral/openl2capchannel(_:)), iOS 11).

### 7.4 Pairing on iOS

- **The app can't start it.** An Apple engineer: "With CoreBluetooth, there is no way to initiate a pairing using the app. Pairing is automatically triggered by the system when either side tries to access a protected characteristic" ([forum 772541](https://developer.apple.com/forums/thread/772541)).
- **What the accessory should do.** "The accessory should not request pairing until an ATT request is rejected using the Insufficient Authentication error code", and services and characteristics should be discoverable without pairing ([Accessory Design Guidelines](https://developer.apple.com/accessories/Accessory-Design-Guidelines.pdf) §57.9–57.10). "Once an accessory is paired with a device, the accessory shall retain the distributed keys … If the pairing is no longer required, the accessory shall delete both sets of keys." The phone uses resolvable private addresses, which the accessory must resolve (§57.8).
- **The person always confirms.** BLE pairing uses "FIPS-approved algorithms (AES-CMAC and P-256 elliptic curve)", offers "numerical comparison or passkey entry", and "pairings require a user response, including all non-MITM pairing modes" ([Bluetooth security](https://support.apple.com/guide/security/bluetooth-security-sec82597d97e/web)).
- **What the app can control.** Which characteristic it touches, and when. The system owns the prompt, the method (Just Works, passkey or numeric comparison, from both sides' I/O capabilities) and the bond. Apart from AccessorySetupKit's `removeAccessory`, there's no API to see or delete a bond.
- **BlueZ's `encrypt-*` flags.** They answer Insufficient *Encryption*, not Authentication (section 6.1). Whether iOS starts pairing on that error is a device test. `secure-*` and `encrypt-authenticated-*` answer the code Apple asks for.

### 7.5 Apple's own mechanisms

- **WAC** (Wireless Accessory Configuration). This is the route where "you don't need to write an app" and Settings configures the accessory, but "supporting WAC requires you to join the MFi Program" (Quinn, Apple DTS, [forum 734344](https://developer.apple.com/forums/thread/734344), revised 2025-11-05). [`EAWiFiUnconfiguredAccessoryBrowser`](https://developer.apple.com/documentation/externalaccessory/eawifiunconfiguredaccessorybrowser) "gives your app access to the MFi Wireless Accessory Configuration process". Not available here.
- **Wi-Fi Information Sharing.** "Devices can share Wi-Fi configuration information with an accessory … only about the currently connected Wi-Fi network", per the Accessory Design Guidelines §47. That section points to the Accessory Interface Specification, which "is available through the Apple MFi Program" (§3.8). Out-of-band Bluetooth pairing (§45) is the same. Not available.
- **`NEHotspotConfiguration`** configures the *iPhone's* Wi-Fi only ([NEHotspotConfiguration](https://developer.apple.com/documentation/networkextension/nehotspotconfiguration)). [`NEHotspotNetwork.fetchCurrent`](https://developer.apple.com/documentation/networkextension/nehotspotnetwork/fetchcurrent(completionhandler:)) returns the current SSID only with the `wifi-info` entitlement and, for example, precise location permission, and never the password. Apple's non-MFi pattern is a sample where the iPhone joins the accessory's own network, reading its details from a QR code, and sends the SSID and a passphrase the person types ([Configuring a Wi-Fi accessory to join a network](https://developer.apple.com/documentation/networkextension/configuring-a-wi-fi-accessory-to-join-a-network)). In that sample, credentials are typed or chosen. iOS never hands them over.
- **Matter.** MatterSupport (iOS 16.1) lets an app commission a device into its own ecosystem. The extension's `selectWiFiNetwork(from:)` gets the device's scan results and returns either `network(ssid:credentials:)` or `defaultSystemNetwork`. "The iOS device must be able to send the device IP traffic after it associates to the given network", and "iOS doesn't store any credentials" ([selectWiFiNetwork](https://developer.apple.com/documentation/mattersupport/matteradddeviceextensionrequesthandler/selectwifinetwork(from:)), [Matter in iOS](https://developer.apple.com/apple-home/matter/)). An uncertified device can still be added through Home's "Add Anyway" ([Matter OTA guide](https://developer.apple.com/accessories/Apple-Matter-OTA-User-Guide.pdf), 2026-02-12). For the bridge Pi, this would mean running the Matter SDK's Linux stack. Its guide reconfigures `wpa_supplicant`'s D-Bus service so the Matter app can write its configuration, and never mentions NetworkManager ([Building Matter](https://project-chip.github.io/connectedhomeip-doc/guides/BUILDING.html)). My inference is that this collides with NetworkManager owning `wlan0`. It would also need an app extension and entitlements, and IP reachability on the new network. It gives one network per commissioning and nothing for saved networks, so it doesn't fit.
- **AccessorySetupKit** (iOS 18). It "discover[s] and configure[s] Bluetooth or Wi-Fi accessories with images and names provided by the app", with consent for "Bluetooth, Wi-Fi, and Local Network permissions", and gives "accessory pairing removal and renaming" ([AccessorySetupKit](https://developer.apple.com/documentation/accessorysetupkit)). For this case:
  - Non-MFi works. The documented requirement is Info.plist keys: `NSAccessorySetupKitSupports` and, for Bluetooth, `NSAccessorySetupBluetoothServices`, names or company IDs ([Discovering and configuring accessories](https://developer.apple.com/documentation/accessorysetupkit/discovering-and-configuring-accessories)). Apple's sample accessory is a second iPhone running an app ([sample](https://developer.apple.com/documentation/accessorysetupkit/setting-up-and-authorizing-a-bluetooth-accessory)).
  - A picker matches by service UUID plus a name substring, service data or manufacturer data. `bluetoothRange = .immediate` limits it to accessories close by ([ASDiscoveryDescriptor](https://developer.apple.com/documentation/accessorysetupkit/asdiscoverydescriptor)).
  - "People will not be asked for permission to use Bluetooth". "Only accessories paired with your app will be returned in the scan results". "The accessory picker will show various Bluetooth-pairing UI if your accessory requires a more secure pairing method, such as numeric comparison and passkey entry" ([WWDC24 10203](https://developer.apple.com/videos/play/wwdc2024/10203/)). With `bluetoothPairingLE` and `confirmAuthorization`, "the app needs to start pairing by accessing a protected GATT characteristic" ([confirmAuthorization](https://developer.apple.com/documentation/accessorysetupkit/aspickerdisplayitem/setupoptions-swift.struct/confirmauthorization)).
  - It does not share Wi-Fi. For Wi-Fi accessories, the descriptor takes the accessory's own `ssid` or `ssidPrefix`, which is the iPhone joining the accessory's hotspot. Apple DTS: "AccessorySetupKit provides … a mechanism for discovering and managing a persistant relationship between your app and a specific accessory … The other APIs then handle the actual connection process" ([forum 758090](https://developer.apple.com/forums/thread/758090)).
  - So it fits: it improves the first connection and pairing, and the app still carries the credentials itself. It needs iOS 18, behind an availability check given the iOS 15 target, and native code, since Capacitor has no plugin for it. Apple also warns: "Don't initialize a CBCentralManager before migration is complete."

## 8. Routes without Bluetooth

### 8.1 Personal Hotspot as a known network

- "Personal Hotspot uses the cellular data connection of an iPhone or iPad" ([111785](https://support.apple.com/en-us/111785)). A saved NetworkManager profile for it, with the hotspot's SSID and password, lets the Pi join wherever the phone has signal, reach the tailnet, and be managed with `nmcli` over Rex, café networks included.
- Apple's instructions for joining over Wi-Fi are: "turn on Allow Others to Join", then "Stay on this screen until the other device has connected to this hotspot" ([Connect to the Personal Hotspot](https://support.apple.com/en-us/111785), [If Personal Hotspot is not working](https://support.apple.com/en-us/119837)). Apple doesn't say whether a device that has joined before can rejoin once the screen is closed. That's a device test.
- Maximize Compatibility (iPhone 12 and later) "turns off 5GHz … limits the device to 2.4GHz, and enforces a WPA2 Personal Security Mode". By default the hotspot is "WPA2/WPA3 Personal" ([Wi-Fi security](https://support.apple.com/guide/security/wi-fi-security-with-apple-devices-secfd166f620/web)). If the Pi has trouble with WPA3 or 6 GHz, this is the switch.
- Costs: cellular data, abroad too, and the phone's battery. It solves "no network", not "get onto the hotel's Wi-Fi", though once the Pi is on the tailnet the person can move it there by shell.

### 8.2 Bluetooth PAN to the iPhone

- iOS supports PAN, which "provides network connectivity over Bluetooth" for Personal Hotspot ([HT204387](https://support.apple.com/en-us/HT204387)). The steps: turn on Allow Others to Join, open Settings → Bluetooth, "Stay on this screen until the other device has connected", choose the iPhone on the computer, compare codes and tap Pair ([111785](https://support.apple.com/en-us/111785)).
- On the Pi, BlueZ's `Network1.Connect("nap")` or a NetworkManager `bluetooth` profile of type `panu` is the client ([Network](https://github.com/bluez/bluez/blob/master/doc/org.bluez.Network.rst), [nm-settings-nmcli](https://networkmanager.dev/docs/api/latest/nm-settings-nmcli.html)).
- The documentation on both sides supports this, but I found no primary source that a BlueZ PANU client works with an iPhone's NAP. Nor did I find whether the app can reach the Pi at its hotspot address over that link, apart from going round through the tailnet. Both are device tests. It's slower than Wi-Fi, and it needs the same hotspot setting, so it doesn't do much that section 8.1 doesn't.

### 8.3 USB-C gadget mode

- On a Pi 5, gadget mode uses the board's USB-C port, which then works "exclusively as USB networking + power input". The Pi presents CDC-ECM to macOS and Linux hosts and RNDIS to Windows. It takes an address from the host's sharing, or serves `10.12.194.1/28` itself ([news post](https://www.raspberrypi.com/news/usb-gadget-mode-in-raspberry-pi-os-ssh-over-usb/), [README](https://github.com/raspberrypi/rpi-usb-gadget)). iOS isn't mentioned.
- iOS has a built-in USB Ethernet driver ("an off-the-shelf USB Ethernet dongle will Just Work™ with iOS … you'll likely bump into local network privacy", Quinn, [forum 802640](https://developer.apple.com/forums/thread/802640)). Apple Support lists "USB to Ethernet adapters" among what the iPhone's port connects ([105099](https://support.apple.com/en-us/105099)). Apple doesn't document whether that driver binds a CDC-ECM gadget.
- Power: the Pi 5 wants a 5 A supply and draws about 800 mA bare ([power supplies](https://www.raspberrypi.com/documentation/computers/raspberry-pi.html#power-supply)). The iPhone supplies "up to 4.5 watts" to small devices ([105099](https://support.apple.com/en-us/105099)). The Pi's only USB-C port is both power and data, and Raspberry Pi suggests a powered hub "to power the device externally while still passing only data". A cable to a phone means carrying a hub and a supply, which defeats the point for travel. It does work as a home or desk route with an iPad or a laptop.

## 9. Captive portals

This is the hardest part of the problem, and BLE provisioning doesn't solve it. A portal admits the device that logged in, and the Pi has no browser and no person.

- **Detect.** NetworkManager reports `PORTAL` only with a connectivity URI configured (section 6.2). A device without connectivity "get[s] a penalty of +20000 to the route-metric" until it logs in ([NetworkManager.conf](https://networkmanager.dev/docs/api/latest/NetworkManager.conf.html)). RFC 8910 lets a network announce its portal's API URI in DHCP or router advertisements ([RFC 8910](https://www.rfc-editor.org/rfc/rfc8910.html)). NetworkManager's NEWS file doesn't mention supporting it, and I found nothing on how many hotels send it.
- **Log in through the Pi.** Raspberry Pi's own hotel tutorial uses "two Wi-Fi devices": a USB adapter joins the hotel and the built-in radio hosts a private network. A phone on that network opens `http://captive.apple.com`, so it logs in with the Pi's upstream address. "You may have to repeat the captive portal step every 12-48 hours" ([Host a hotel Wi-Fi hotspot](https://www.raspberrypi.com/tutorials/host-a-hotel-wifi-hotspot/)). GL.iNet's routers do the same ([captive portal FAQ](https://docs.gl-inet.com/router/en/4/faq/connect_to_a_hotspot_with_captive_portal/)). This is the most robust route, but it costs a USB Wi-Fi adapter and makes the bridge a router.
- **Clone the phone's address.** GL.iNet: some hotels "limit the number of devices each customer can connect" by recorded MAC. The fix is to copy the "Wi-Fi Address" the phone used on that network into the router, and to mind that private addresses mean the address shown is the one for that network (same page). iOS uses "a different MAC address for each Wi-Fi network", Fixed by default on WPA2-or-better networks and Rotating "every 2 weeks" on weak or open ones ([private Wi-Fi addresses](https://support.apple.com/en-us/102509)). The Pi can take that address per connection through `802-11-wireless.cloned-mac-address`. The phone then has to leave that network, or two stations share one address. Whether a given portal accepts this is a device test.
- **Relay the portal over Bluetooth.** I found no existing implementation. The parts exist: an L2CAP channel (Core Bluetooth `openL2CAPChannel`, BlueZ `BT_MODE_LE_FLOWCTL`), a proxy in the app, and a `WKWebView` whose data store sends its traffic through a `ProxyConfiguration` (iOS 17, [proxyConfigurations](https://developer.apple.com/documentation/webkit/wkwebsitedatastore/proxyconfigurations-cdc1), [ProxyConfiguration](https://developer.apple.com/documentation/network/proxyconfiguration)). The portal would then see the Pi log in, with the person doing it on the phone. Throughput and whether portals render through it are unknown, and it's a project of its own.
- **Avoid it.** Use the Personal Hotspot (section 8.1).

## 10. Recommendation

### 10.1 The route

1. **First, with no code:** before travelling, save the iPhone's Personal Hotspot as a NetworkManager profile on the Pi, at a priority below known home and work networks, and turn on connectivity checking. With no known network around, the person turns on the hotspot, the Pi reaches the tailnet, and Rex and `nmcli` do everything else, café Wi-Fi included. This covers bootstrapping now, and it stays as the recovery path if Bluetooth fails or the bond is lost.
2. **Then, if Bluetooth is still wanted** (no cellular data, or to manage networks without the hotspot): write a small GATT service of our own in front of NetworkManager. Don't adopt an existing protocol:
   - Improv covers one network and has no security (section 3).
   - nymea covers more, but demands no encryption or authentication and can't forget networks (section 5).
   - btwifiset's protocol is undocumented, and its encryption uses a weak password-derived key.
   - Espressif's protocol has the right security, but no Linux device side and a one-network model (section 4).
   - None of them has a client the app could reuse without writing the same amount of code.

   Everything the service needs is a D-Bus call that NetworkManager already has (section 6.2).
3. **Captive portals are a separate decision** (section 9). The service should at least report `PORTAL`. Cloning the phone's address is cheap to try. A second radio as a travel router is the robust fix.

This is not a Host feature. The app would speak to a device other than a Host, over something other than the Host protocol, which `app/AGENTS.md` excludes today ("speaks the Host protocol … and never ACP or MCP"). It needs an issue and probably an ADR.

### 10.2 The Pi side

- **A small daemon.** For example, Rust on `bluer` and a D-Bus crate, or Python on BlueZ's D-Bus API. It registers one service and an advertisement with its service UUID and a short name. It talks to NetworkManager only over D-Bus, never through a shell.
- **Operations:**
  - status: SSID, IPv4 and IPv6, connectivity state, tailnet state;
  - scan: SSID, signal, security, band;
  - list saved networks with their priorities;
  - add and join;
  - forget;
  - set priority;
  - set a cloned MAC address on a connection;
  - and possibly Identify (blink the LED).
- **Messages.** One write characteristic and one notify characteristic carrying framed requests and responses, as nymea and Improv both do. Writes are limited to the MTU less 3 bytes (section 7.2).
- **When it's on.** It advertises only while the Pi isn't on the tailnet or NetworkManager's connectivity isn't `FULL`, and for a few minutes after boot. It stops once the tailnet is up. That matches the brief and keeps the radio quiet most of the time. A Pi 5 power button on Lite starts a shutdown ([power button](https://www.raspberrypi.com/documentation/computers/raspberry-pi.html#power-button)). Taking that key over to open a window would be a physical-presence signal, but it's untested.

### 10.3 The app side

- Use `@capacitor-community/bluetooth-le` 8.3.0 for scanning, connecting, writing and notifications. Keep the protocol (framing, messages, signing) in TypeScript under `src/`, so Vitest tests it like the Host client. Add `NSBluetoothAlwaysUsageDescription`. No background mode is needed.
- AccessorySetupKit is the better first connection on iOS 18 and later: a system picker, no Bluetooth prompt, and pairing UI in the picker. But it needs an in-app Swift plugin and doesn't change what crosses the link. It can come later. Whether the community plugin's scan and `connect` work on an accessory that AccessorySetupKit authorised is a device test (section 11).
- The person types the password. iOS gives no API for the current network's credentials (section 7.5), so the app can at best suggest the SSID it's on.

### 10.4 Security

- **Who can connect.** Anyone in range can connect to a BLE peripheral and discover its services, and Apple asks that discovery stay open (§57.9). Security lives in what a connection can read or write, and in who can pair.
- **Bond once, at home, authenticated.**
  - The person opens a pairing window from the tailnet: the daemon turns `Pairable` on with a short `PairableTimeout`, under an agent registered as `DisplayOnly`.
  - The app touches a protected characteristic, and iOS starts pairing.
  - The kernel's random passkey reaches the agent's `DisplayPasskey`, which prints it in the person's Rex terminal. The person types it into iOS's prompt.
  - That gives an authenticated LE Secure Connections bond (FIPS level).
- **Every value is `secure-read` or `secure-write`.** So only a bonded, authenticated iPhone gets past Insufficient Authentication. Outside the window `Pairable` is off, so pairing attempts from anyone else fail. Set `SecureConnections = only` in BlueZ's `main.conf`. Just Works is never accepted, since it gives an unauthenticated key that a man in the middle at pairing time can share (section 6.1).
- **Credentials cross encrypted.** The link is encrypted with AES-CCM under the bonded key ([Bluetooth security](https://support.apple.com/guide/security/bluetooth-security-sec82597d97e/web)). No encryption at the application layer is needed on top. btwifiset and teton-provision add their own because they don't rely on bonding.
- **A second factor.** Sign each command that changes something with the app's existing P-256 device key, enrolled with the bridge over the tailnet, and include a counter against replay. A stolen bond, or a phone that is bonded but not enrolled, then can't change the network. The daemon also knows which device asked, and it can log each change.
- **Privacy.** With BlueZ `Privacy` off, the Pi advertises a fixed address and a fixed name everywhere it travels. `Privacy = device` rotates the address, and the bonded phone resolves it with the IRK it received at bonding. Whether iOS reconnects smoothly to a peripheral that rotates its address is a device test.
- **The risk this service adds.** A BLE service that can change the bridge's network can:
  - move the Pi onto an attacker's access point, where traffic that isn't end to end, such as package and firmware downloads and DNS, can be tampered with;
  - forget every network, which is denial of service;
  - leak where the person is through scan results.

  The bridge also has agents with access to microcontrollers and networks, so the service runs with NetworkManager's rights and exposes the Bluetooth stack to anyone nearby whenever it advertises. The mitigations above (authenticated bonding only, signed commands, advertising only while off the tailnet, no shell, logging) are what make it acceptable. Without them, the hotspot route is the safer one.
- **Recovery.** If the bond is lost (a new phone, a forgotten device, or a reinstalled Pi with new keys), go back to section 10.1's hotspot and pair again over the tailnet. Both sides must drop stale keys: the accessory "shall delete both sets of keys" (§57.10), and on the phone that means forgetting the device.

### 10.5 What this isn't

- Not a generic provisioning product. It works for the person's own iPhone and Pi, bonded at home.
- Not a fix for captive portals.
- Not something the weave Host or its protocol needs to change for.

## 11. What only a device test can settle

- **The hotspot.** Whether a Pi that has joined before rejoins the iPhone's Personal Hotspot with the Personal Hotspot screen closed and the phone locked, and for how long it stays visible. Whether the Pi 5 joins the default WPA2/WPA3 hotspot or needs Maximize Compatibility.
- **Pairing.**
  - That iOS shows passkey entry for a BlueZ peripheral registered `DisplayOnly`.
  - That `btmon` shows LE Secure Connections and the FIPS level after bonding.
  - That `secure-*` characteristics then read and write.
  - What iOS does on BlueZ's Insufficient *Encryption* from `encrypt-*` flags.
  - That pairing fails cleanly with `Pairable` off.
- **The battery plugin.** Whether BlueZ's battery plugin trying to read the iPhone's Battery Service causes pairing prompts or drops connections (section 6.1), and whether `-P battery` is needed.
- **Address privacy.** Reconnection with BlueZ `Privacy = device`, and how stale bonds behave on both sides after a reinstall.
- **Coexistence.** Advertising and staying connected over BLE while the same CYW43455 scans and joins Wi-Fi, especially during `RequestScan`.
- **rfkill.** Whether Bluetooth is soft-blocked by default on a fresh trixie Lite image on the Pi 5, as btwifiset's README reports for some boards.
- **Connectivity checking.** Whether the Lite image installs `network-manager-config-connectivity-debian`. `nmcli networking connectivity check` returns `unknown` if not.
- **The plugin.** MTU and write sizes in practice. Whether `@capacitor-community/bluetooth-le` connects to an accessory authorised through AccessorySetupKit, and whether its scan sees it.
- **USB.** Whether iOS's USB Ethernet driver binds the Pi's CDC-ECM gadget. Whether an iPhone or iPad can power a Pi 5 through the gadget port at all, or only with a powered hub. Whether the Local Network prompt appears.
- **Bluetooth PAN.** Whether a BlueZ PANU client joins the iPhone's NAP, and whether the app can reach the Pi over it directly.
- **Captive portals.** For each real hotel or café network: whether cloning the phone's address passes the portal, and how long the login lasts. Whether the network isolates clients from each other, which decides whether the phone can reach the Pi over that Wi-Fi at all.
- **The power button.** Whether its key event on Lite can be taken from logind and used to open a pairing window.
