# Open-source alternatives to Warp's terminal Block concept

_Research snapshot: 2026-08-01. Primary sources only._

## Answer

Yes, but there is no convincing **tmux-only plugin** that turns an arbitrary terminal into Warp. The closest results fall into three different categories:

1. **Use the now-open-source Warp client** for Warp's exact model. Warp's repository licenses most of the client under AGPLv3 and its UI crates under MIT. Its renderer is structurally block-native: each terminal block owns separate command and output grids, rather than decorating one conventional scrollback grid. ([Warp repository and licensing](https://github.com/warpdotdev/Warp), [Warp's block-model explanation](https://www.warp.dev/blog/block-model-behind-warps-agentic-development-environment))
2. **Use another block/frame-aware terminal.** Extraterm's Frames are the closest independent visual analogue for an ordinary interactive zsh session. iTerm2's Command Selection is the closest polished conventional-terminal approximation on macOS. Wave Terminal offers first-class command blocks, but they are explicit `wsh run` jobs rather than automatic grouping of every command typed into a normal interactive terminal.
3. **Add semantic shell integration to a conventional terminal.** OSC 133 lets zsh mark prompt, input, output, and exit-status boundaries. Konsole, VS Code, kitty, Ghostty, Windows Terminal, WezTerm, and iTerm2 use those boundaries for command navigation, whole-output selection, status marks, sticky headers, or command actions. This delivers much of the practical value without changing the terminal's underlying single-grid scrollback model.

For an existing zsh/tmux workflow, the best answer is therefore: **choose an OSC-133-aware outer terminal and enable its zsh shell integration; keep tmux for persistence and multiplexing.** Do not expect a tmux plugin alone to provide block rendering.

## Comparison

| Option | Classification | What it provides | Main limitation | Maintenance signal at cutoff |
| --- | --- | --- | --- | --- |
| **Warp** | Exact | Automatic command+output blocks; block selection/navigation/actions; separate command/output grids | It is still Warp, not an add-on for another terminal; most code is AGPLv3 | Public upstream client repo, build instructions, and active contribution workflow ([repo](https://github.com/warpdotdev/Warp)) |
| **Extraterm Frames** | Exact independent analogue | zsh/bash/fish hooks; framed output with command title and status; sticky frame header; delete, pop out, collapse, and reuse output | Requires switching terminals; framing centers on output rather than Warp's complete input editor/block system | MIT repo, modern Qt line, downloadable nightlies, and v0.82 release line ([repo](https://github.com/sedwards2009/extraterm), [releases](https://github.com/sedwards2009/extraterm/releases)) |
| **iTerm2 Command Selection** | Near-exact | Click command or output to outline the whole region; previous/next navigation; scoped search/filter/select; resend, copy, share, bookmark; command metadata | macOS only; selected regions remain semantic zones in conventional scrollback, not independently laid-out blocks | Active GPL-2.0 upstream project and current first-party docs ([repo](https://github.com/gnachman/iTerm2), [docs](https://iterm2.com/documentation-command-selection.html)) |
| **Wave Terminal `wsh run`** | Block-native, different interaction | Runs one command in a separately addressable block; rerun, pause, auto-close, append, magnify, query/delete through `wsh` | A normal terminal block still behaves like a normal terminal; commands become separate blocks only when launched explicitly | Apache-2.0, cross-platform, v0.14.5 released 2026-04-16 ([repo](https://github.com/wavetermdev/waveterm), [`wsh run`](https://docs.waveterm.dev/wsh-reference#run)) |
| **Konsole semantic integration** | Strong approximation | Visual bars/backgrounds around command regions, failure styling, prompt navigation, copy input/output separately, whole-output selection | Linux/KDE terminal; no independent block lifecycle, sharing, or persistence | Current KDE documentation and maintained Konsole codebase ([docs](https://docs.kde.org/trunk_kf6/en/konsole/konsole/semantic-shell-integration.html)) |
| **VS Code terminal shell integration** | Strong approximation | Command guide, status decorations, sticky command header, navigation, output selection/copy, rerun, recent-command output | Integrated IDE terminal; conventional scrollback; branded VS Code and Code OSS distribution/licensing boundaries differ | Actively documented and supports both its richer OSC 633 protocol and portable OSC 133 ([docs](https://code.visualstudio.com/docs/terminal/shell-integration)) |
| **kitty / Ghostty** | Lightweight approximation | Jump prompt-to-prompt; select or open one command's output; shell-aware status/close behavior | Little or no persistent visible block chrome; actions are scrollback-oriented | Both have current upstream shell-integration documentation ([kitty](https://sw.kovidgoyal.net/kitty/shell-integration/), [Ghostty](https://ghostty.org/docs/features/shell-integration)) |
| **Windows Terminal** | Lightweight approximation | Stable marks, prompt navigation, select command/output, success/failure state via OSC 133 | Windows only; command regions are marks, not blocks | Marks stable since Terminal 1.21 in Microsoft's current docs ([docs](https://learn.microsoft.com/windows/terminal/tutorials/shell-integration)) |
| **WezTerm** | Protocol substrate / light approximation | OSC 133 input/output/prompt zones, prompt navigation and semantic-zone selection; zsh/bash integration examples | Does not present Warp-like block cards or block lifecycle | Upstream docs expose the portable protocol and tmux-related setup ([docs](https://wezterm.org/shell-integration.html)) |

## The closest independent match: Extraterm Frames

Extraterm is the only independent project in this survey whose official user-facing model is explicitly a frame around each command's output. Its shell integration hooks command invocation and completion for bash, zsh, and fish. A frame carries the command name and success/failure state; its title stays visible while scrolling; controls can delete the output or move it to a separate tab. The `from` command can feed the contents of a prior frame into a new command. ([Extraterm guide](https://extraterm.org/guide.html#shell-integration), [upstream repository](https://github.com/sedwards2009/extraterm))

That is materially closer to Warp than a prompt mark. The difference is architectural and experiential: Warp makes command and output blocks the terminal's native storage/rendering unit, while Extraterm augments a terminal session with framed output. Warp can therefore apply selection, sharing, agent content, and other actions uniformly across a typed `BlockList`; Extraterm's frame feature is narrower. ([Warp block model](https://www.warp.dev/blog/block-model-behind-warps-agentic-development-environment))

Extraterm should be trialed rather than adopted from the feature list alone. It is a substantial terminal replacement, not a zsh plugin, and a test should cover the TUIs, alternate-screen applications, SSH sessions, fonts, clipboard behavior, and tmux workflow actually used.

## The closest conventional-terminal match: iTerm2

iTerm2 now comes surprisingly close to Warp's everyday Block interactions without replacing scrollback with a block renderer. With shell integration installed, clicking a command or its output outlines the command+output region and dims other content. Search, filtering, and Select All become region-scoped; keyboard navigation moves between commands; an info panel exposes duration and exit status plus resend/copy/share controls; and the region can be bookmarked as a named mark. ([Command Selection](https://iterm2.com/documentation-command-selection.html))

Its shell integration also tracks working directory, command history, and exit status, and adds prompt marks that can be navigated with the keyboard. ([Shell Integration](https://iterm2.com/documentation-shell-integration.html))

For a macOS user who wants to keep zsh and retain a mostly conventional terminal, this is the strongest recommendation. It provides most of the high-frequency Block affordances—identify, navigate, select, copy, inspect, and rerun a command unit—without asking the user to adopt Warp's editor or agent environment.

## The portable building block: OSC 133 semantic prompts

A PTY normally carries an undifferentiated byte stream. The terminal cannot reliably infer which bytes are the prompt, typed command, foreground output, or unrelated background output. Shell integration solves this by emitting invisible semantic boundary sequences:

| Sequence | Meaning |
| --- | --- |
| `OSC 133 ; A` | prompt starts |
| `OSC 133 ; B` | prompt ends / command input starts |
| `OSC 133 ; C` | command was executed / output starts |
| `OSC 133 ; D ; <exit>` | command ends, optionally with exit status |

This convention began with FinalTerm and is now implemented across several terminals. Windows Terminal documents the four boundaries directly; WezTerm documents prompt/input/output zones and ships zsh/bash examples; VS Code accepts OSC 133 in addition to its richer OSC 633 protocol. ([Windows Terminal protocol](https://learn.microsoft.com/windows/terminal/tutorials/shell-integration), [WezTerm shell integration](https://wezterm.org/shell-integration.html), [VS Code supported sequences](https://code.visualstudio.com/docs/terminal/shell-integration#_supported-escape-sequences))

The important boundary is that **OSC 133 supplies semantics, not UI**. Each terminal chooses what to build from the same marks:

- Konsole draws bars/backgrounds and offers command-specific copy actions.
- iTerm2 exposes selection, metadata, sharing, and resend controls.
- VS Code draws guides/decorations and a sticky command header.
- kitty and Ghostty emphasize navigation and selecting/showing one command's output.
- Windows Terminal exposes marks, navigation, and output selection.

This is why a small shell plugin cannot, by itself, reproduce Warp. It can label regions, but only the renderer can draw outlines, virtualize blocks, attach buttons, persist metadata, or give a block its own lifecycle.

### zsh integration choices

Prefer the integration shipped by the chosen terminal. It is tested against that terminal's exact protocol extensions and can avoid duplicate hooks:

- iTerm2, VS Code, kitty, Ghostty, WezTerm, and Extraterm all ship or document zsh integration.
- Powerlevel10k can emit OSC 133 when `POWERLEVEL9K_TERM_SHELL_INTEGRATION=true`, which is useful when the prompt theme needs to own the hooks. It is not an ideal new dependency solely for this purpose: upstream now states that support is very limited, no new features are planned, and most bugs will go unfixed. ([Powerlevel10k repository](https://github.com/romkatv/powerlevel10k), [semantic-integration implementation history](https://github.com/romkatv/powerlevel10k/releases/tag/v1.16.0))
- A zsh 5.10 development patch adds native semantic markers through `.term.extensions`, explicitly to avoid users needing plugins. At the research cutoff this is development-line evidence, not a safe assumption for system zsh installations. ([zsh workers patch](https://www.zsh.org/mla/workers/2025/msg00106.html))

Do not load several integrations simultaneously. Multiple `precmd`, `preexec`, prompt, or ZLE wrappers can duplicate/misorder boundary markers. Pick one owner and validate complex prompts, multiline input, nested shells, SSH, jobs that keep writing after the foreground command exits, and full-screen TUIs.

## Why there is no tmux-only answer

tmux owns pseudo-terminals, multiplexes panes, and retains scrollback. Its documented control mode groups **tmux control commands and their replies**, not the interactive shell commands rendered inside a pane. That use of the word “block” is unrelated to Warp's Block model. ([tmux control mode](https://github.com/tmux/tmux/wiki/Control-Mode), [tmux project](https://github.com/tmux/tmux))

A tmux plugin can add key bindings, inspect pane text, or invoke copy mode, but it does not own the outer terminal's renderer. Retrofitting real blocks inside tmux would require heuristically parsing pane history and drawing overlays in terminal cells, which cannot provide Warp's independent layout, reliable command/output identity, or block-local UI controls.

The workable tmux design is:

```text
zsh hook or integration -> emits semantic boundaries
tmux                  -> transports/multiplexes the pane stream
outer terminal        -> interprets boundaries and renders command-aware UI
```

Whether a particular integration survives tmux depends on how that terminal and script handle escape-sequence passthrough. WezTerm, for example, documents `allow-passthrough` for its user variables when inside tmux; this is evidence that tmux compatibility is a configuration concern, not that tmux itself implements semantic blocks. ([WezTerm tmux note](https://wezterm.org/shell-integration.html))

## Recommendations

1. **Exact Warp behavior, open source required:** use or fork the now-open-source Warp client. This is the only exact implementation because Blocks are foundational renderer/storage objects, not decorations.
2. **Keep macOS + zsh, minimize workflow disruption:** use iTerm2 Shell Integration and Command Selection. Add tmux only for the persistence/multiplexing you actually need, and validate the selected tmux mode.
3. **Visible independent frames on Linux/macOS/Windows:** trial Extraterm. It is the closest separate project, and its v0.82 line includes frame collapse/expand, but treat the terminal switch as a real compatibility evaluation.
4. **Linux/KDE:** enable Konsole semantic shell integration for the best block-like conventional-terminal UI.
5. **Cross-platform and already living in an IDE:** VS Code's integrated terminal gives the richest non-terminal-replacement approximation, including sticky command headers and rerun/copy actions.
6. **Fast native terminal with light UI:** choose kitty or Ghostty for prompt navigation and whole-output selection. This captures the ergonomic core without visible cards.
7. **Explicit long-running jobs in separate blocks:** Wave Terminal's `wsh run` is compelling, but understand that it is a workspace/job-block model rather than automatic Warp-style grouping within an interactive shell.

## Limitations

- “No tmux-only plugin” means no credible, maintained implementation was found in upstream tmux documentation, the official plugin ecosystem material reviewed, or primary-source searches at the cutoff. It is not proof that no experimental dotfile exists.
- Background processes can write after a command has ended, and simultaneous jobs can interleave bytes. Even Warp documents that background output sometimes cannot be attributed perfectly. ([Warp background blocks](https://docs.warp.dev/terminal/blocks/background-blocks))
- Shell integration may be lost in nested shells, plain SSH sessions, containers, or privilege boundaries unless integration is installed or forwarded there. Ghostty explicitly documents the nested-shell boundary. ([Ghostty shell integration](https://ghostty.org/docs/features/shell-integration#switching-shells-with-shell-integration))
- Full-screen and alternate-screen applications do not naturally fit a permanent command-output-card model. Any candidate should be tested with the actual TUI workload.
- Open-source status, feature availability, and activity can change. The classifications above describe the cited upstream state at 2026-08-01.
