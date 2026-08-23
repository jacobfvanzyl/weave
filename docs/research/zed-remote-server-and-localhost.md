# Zed remote server provisioning and same-host loopback

_Research snapshot: 2026-08-20. Primary Zed documentation and source only._

## Answer

Installing or running the Zed desktop editor does **not** turn that machine into an always-listening Zed remote host. Zed's remote-development architecture has two roles:

- the local desktop application runs the UI; and
- a separate, headless `zed-remote-server` runs beside the source code, language servers, tasks, and terminals on the SSH target.

You normally do **not** install or launch that headless server yourself. After you choose **Connect New Server**, Zed uses the `ssh` executable on the local machine, checks the target for an exactly matching binary under `~/.zed_server`, downloads it if it is missing or mismatched, and starts it. If the target cannot download from the internet, `"upload_binary_over_ssh": true` tells Zed to download the binary locally and copy it over SSH. Manual installation or a custom build is an optional escape hatch, and the manually installed binary must exactly match the desktop Zed channel and version. ([Zed remote-development setup and configuration](https://zed.dev/docs/remote-development#setup), [server initialization](https://zed.dev/docs/remote-development#initializing-the-remote-server))

The prerequisite that must already exist is ordinary SSH access to the target, including an SSH server on that machine where applicable. The Zed desktop application is not itself that SSH service or a general-purpose network server.

## Is the same physical machine via `localhost` supported?

There are two different answers:

1. **Mechanically, it should work.** If `ssh localhost` works for the intended account, Zed's SSH URL and connection parser accept an arbitrary hostname or IP address and do not reject a loopback destination. Zed would follow its normal provisioning path and put the matching headless binary in that same account's `~/.zed_server`. This is an inference from the current connection parser and provisioning path, not an explicit product promise. ([SSH connection parser](https://github.com/zed-industries/zed/blob/main/crates/remote/src/transport/ssh.rs#L1538-L1647), [server-binary provisioning](https://github.com/zed-industries/zed/blob/main/crates/remote/src/transport/ssh.rs#L761-L878))
2. **It is not a documented supported topology.** Zed's official overview explicitly says remote development "requires two computers": a local UI machine and a remote server. The documentation does not describe connecting back to the same physical host as a supported workflow. ([remote-development architecture](https://zed.dev/docs/remote-development#overview))

An issue in Zed's own tracker records a working command whose apparent SSH destination was `localhost:<port>`, but that port was a tunnel to another machine. It confirms that a loopback host string can work; it does **not** establish same-physical-machine remoting as an officially supported use case. ([Zed issue #30702](https://github.com/zed-industries/zed/issues/30702))

The safest classification is therefore: **same-host SSH remoting is technically viable but outside the topology Zed documents and promises.** It requires a local SSH daemon and incurs an extra SSH/headless-server layer. A normal local Zed project remains the supported choice when no execution boundary is needed.

## Architectural consequence

The headless binary should not be treated as a public editor-service API. Zed starts it in proxy mode through managed SSH connections and reconnects to its daemon when needed. It is an implementation component of Zed remote development, not evidence that a running Zed GUI exposes a reusable remote-control endpoint. ([connection lifecycle](https://zed.dev/docs/remote-development#maintaining-the-ssh-connection))

For a companion integration such as Weave, use the supported `zed` CLI to open a local file or project in the desktop application. Do not base the integration on directly launching or speaking to `zed-remote-server`. Same-host SSH is reasonable only if its SSH execution boundary is itself the feature being tested.

If the actual goal is a reproducible or isolated environment on the same physical machine, Zed's documented remote-like workflow is a [Dev Container](https://zed.dev/docs/dev-containers): Zed builds and launches the container, then runs tasks, terminals, and language servers inside it while retaining the local UI. That is a first-class same-host workflow, although the feature is still marked as under development.

## Caveats

- On a same-account, same-host loopback, the paths documented as separate local and server settings resolve to the same home directory. Zed's docs assume distinct machines and do not specify the behavior of this overlap. ([remote settings locations](https://zed.dev/docs/remote-development#zed-settings))
- The remote binary is version-coupled to the desktop app, so a manually maintained installation must be updated in lockstep.
- A loopback URL that terminates in an SSH tunnel to a genuinely remote machine is a normal SSH routing technique; that is different from running both Zed roles on the same OS instance.
