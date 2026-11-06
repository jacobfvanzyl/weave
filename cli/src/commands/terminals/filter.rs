//! What `weave terminal attach` leaves out of a terminal's output before its own terminal sees it
//! (ADR 0022, WVE-167). The holder's libghostty-vt answers the program's queries, so the
//! terminal the attach runs in, which would answer them again, never sees them: device
//! attributes, status and cursor reports, mode, version, window, key-mode and colour queries,
//! DECRQSS and XTGETTCAP. Clipboard writes (OSC 52) and notifications (OSC 9 and 777) reach a
//! device through the Host, which sends a clipboard write only to the device that typed last, so
//! they're left out too and the attach writes the Host's own. Kitty graphics are left out as the
//! app leaves them undrawn: a terminal that drew them would answer them as well.
//!
//! Everything else passes through byte for byte, sequences split across chunks included. A
//! sequence is held only as long as it takes to tell what it is, so a large payload, such as an
//! image's or a clipboard write's, streams through or is dropped without being kept.

/// How many bytes of a sequence are held to tell what it is; past that it passes through.
const HOLD: usize = 4096;

#[derive(Default)]
pub struct Filter {
    state: State,
    /// The sequence held so far, from its ESC.
    held: Vec<u8>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum State {
    #[default]
    Ground,
    /// After ESC.
    Escape,
    /// In a CSI, before its final byte.
    Csi,
    /// In an OSC, its number still being read or its payload held.
    Osc,
    /// In an OSC, DCS or APC let through, until its terminator.
    Pass,
    /// In one being dropped, until its terminator.
    Drop,
    /// In a DCS, before its first two bytes say what it is.
    Dcs,
    /// In an APC, before its first byte says what it is.
    Apc,
}

impl Filter {
    /// `output` with what the program's terminal shouldn't see taken out.
    pub fn feed(&mut self, output: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(output.len());
        let mut index = 0;
        while index < output.len() {
            let byte = output[index];
            index += 1;
            match self.state {
                State::Ground => match byte {
                    0x1b => self.hold(byte, State::Escape),
                    // ENQ, which a terminal answers with its answerback.
                    0x05 => {}
                    _ => out.push(byte),
                },
                State::Escape => match byte {
                    b'[' => self.keep(byte, State::Csi),
                    b']' => self.keep(byte, State::Osc),
                    b'P' => self.keep(byte, State::Dcs),
                    b'_' => self.keep(byte, State::Apc),
                    // DECID, which asks for the device's attributes.
                    b'Z' => self.reset(),
                    _ => {
                        self.held.push(byte);
                        self.release(&mut out);
                    }
                },
                State::Csi => {
                    self.held.push(byte);
                    if (0x40..=0x7e).contains(&byte) {
                        if is_query_csi(&self.held[2..]) {
                            self.reset();
                        } else {
                            self.release(&mut out);
                        }
                    } else if byte == 0x1b || self.held.len() > HOLD {
                        // Not a CSI after all: let it through, and take the ESC again.
                        let escape = byte == 0x1b;
                        if escape {
                            self.held.pop();
                        }
                        self.release(&mut out);
                        if escape {
                            self.hold(byte, State::Escape);
                        }
                    }
                }
                State::Osc => {
                    if let Some(ended) = terminator(&mut self.held, byte) {
                        let drop = ended && is_dropped_osc(&osc_body(&self.held));
                        if drop {
                            self.reset();
                        } else {
                            self.release(&mut out);
                        }
                        continue;
                    }
                    match osc_choice(&osc_body(&self.held)) {
                        Choice::Undecided if self.held.len() <= HOLD => {}
                        Choice::Drop => self.state = State::Drop,
                        Choice::Undecided | Choice::Pass => {
                            out.extend_from_slice(&self.held);
                            self.held.clear();
                            self.state = State::Pass;
                        }
                    }
                }
                State::Dcs => {
                    if terminator(&mut self.held, byte).is_some() {
                        self.release(&mut out);
                        continue;
                    }
                    if self.held.len() >= 4 {
                        // DECRQSS (`$q`) and XTGETTCAP (`+q`) ask for answers.
                        if matches!(&self.held[2..4], b"$q" | b"+q") {
                            self.state = State::Drop;
                        } else {
                            out.extend_from_slice(&self.held);
                            self.held.clear();
                            self.state = State::Pass;
                        }
                    }
                }
                State::Apc => {
                    if terminator(&mut self.held, byte).is_some() {
                        self.release(&mut out);
                        continue;
                    }
                    if self.held.len() >= 3 {
                        if self.held[2] == b'G' {
                            self.state = State::Drop;
                        } else {
                            out.extend_from_slice(&self.held);
                            self.held.clear();
                            self.state = State::Pass;
                        }
                    }
                }
                State::Pass => {
                    // Only the terminator's two bytes are held, to find it across chunks.
                    self.held.push(byte);
                    if ends_string(&self.held) {
                        out.extend_from_slice(&self.held);
                        self.reset();
                    } else if self.held.len() >= 2 || byte != 0x1b {
                        let keep_escape = byte == 0x1b;
                        let held = std::mem::take(&mut self.held);
                        if keep_escape {
                            out.extend_from_slice(&held[..held.len() - 1]);
                            self.held.push(0x1b);
                        } else {
                            out.extend_from_slice(&held);
                        }
                    }
                }
                State::Drop => {
                    self.held.push(byte);
                    if ends_string(&self.held) {
                        self.reset();
                    } else {
                        let escape = byte == 0x1b;
                        self.held.clear();
                        if escape {
                            self.held.push(0x1b);
                        }
                    }
                }
            }
        }
        out
    }

    fn hold(&mut self, byte: u8, state: State) {
        self.held.clear();
        self.held.push(byte);
        self.state = state;
    }

    fn keep(&mut self, byte: u8, state: State) {
        self.held.push(byte);
        self.state = state;
    }

    fn release(&mut self, out: &mut Vec<u8>) {
        out.extend_from_slice(&self.held);
        self.reset();
    }

    fn reset(&mut self) {
        self.held.clear();
        self.state = State::Ground;
    }
}

/// A string sequence's terminator: BEL, or ST (ESC `\`). `Some(true)` when `byte` ended it,
/// `Some(false)` when an ESC that isn't ST did, which aborts it; `held` takes `byte` either way.
fn terminator(held: &mut Vec<u8>, byte: u8) -> Option<bool> {
    held.push(byte);
    if byte == 0x07 || held.ends_with(b"\x1b\\") {
        return Some(true);
    }
    let len = held.len();
    if len >= 2 && held[len - 2] == 0x1b && byte != b'\\' {
        return Some(false);
    }
    None
}

fn ends_string(held: &[u8]) -> bool {
    held.last() == Some(&0x07) || held.ends_with(b"\x1b\\")
}

/// An OSC's text between `ESC ]` and its terminator, which may not have come yet.
fn osc_body(held: &[u8]) -> Vec<u8> {
    let body = &held[2..];
    let body = body.strip_suffix(b"\x1b\\").unwrap_or(body);
    let body = body.strip_suffix(b"\x07").unwrap_or(body);
    body.strip_suffix(b"\x1b").unwrap_or(body).to_vec()
}

enum Choice {
    Undecided,
    Pass,
    Drop,
}

/// What to do with an OSC whose start is `body`.
fn osc_choice(body: &[u8]) -> Choice {
    let Some(semicolon) = body.iter().position(|&byte| byte == b';') else {
        return if body.iter().all(u8::is_ascii_digit) {
            Choice::Undecided
        } else {
            Choice::Pass
        };
    };
    match &body[..semicolon] {
        b"52" | b"777" => Choice::Drop,
        // ConEmu's progress (`9;4;…`) shows; its notifications (`9;text`) reach devices.
        b"9" => match body.get(semicolon + 1..semicolon + 3) {
            None if body.len() <= semicolon + 2 => Choice::Undecided,
            Some(b"4;") => Choice::Pass,
            _ => Choice::Drop,
        },
        // Colours, which a `?` in place of a value asks for: held whole to tell.
        b"4" | b"5" | b"10" | b"11" | b"12" | b"13" | b"14" | b"15" | b"16" | b"17" | b"18"
        | b"19" | b"21" => Choice::Undecided,
        _ => Choice::Pass,
    }
}

/// An ended OSC that asks for an answer, or reaches devices through the Host.
fn is_dropped_osc(body: &[u8]) -> bool {
    match osc_choice(body) {
        Choice::Drop => true,
        Choice::Pass => false,
        Choice::Undecided => body
            .split(|&byte| byte == b';')
            .skip(1)
            .any(|field| field == b"?" || field.ends_with(b"=?")),
    }
}

/// A CSI, from its parameters to its final byte, that asks the terminal for an answer.
fn is_query_csi(sequence: &[u8]) -> bool {
    let Some((&last, params)) = sequence.split_last() else {
        return false;
    };
    let first = params.first().copied();
    let numbers = |params: &[u8]| -> Vec<u8> {
        params
            .iter()
            .copied()
            .filter(|byte| byte.is_ascii_digit() || *byte == b';')
            .collect()
    };
    match last {
        // DA1, DA2 and DA3.
        b'c' => matches!(params, b"" | b"0" | b">" | b">0" | b"=" | b"=0"),
        // Device status and cursor position reports; `CSI > … n` sets a key mode instead.
        b'n' => first != Some(b'>'),
        // DECRQM, `CSI ? Ps $ p` and `CSI Ps $ p`.
        b'p' => params.ends_with(b"$"),
        // The kitty keyboard protocol's flags.
        b'u' => params == b"?",
        // XTVERSION; `CSI Ps SP q` sets the cursor's shape instead.
        b'q' => first == Some(b'>'),
        // XTWINOPS reports.
        b't' => {
            let params = numbers(params);
            let op = params
                .split(|&byte| byte == b';')
                .next()
                .unwrap_or_default();
            matches!(
                op,
                b"11" | b"13" | b"14" | b"15" | b"16" | b"18" | b"19" | b"20" | b"21"
            )
        }
        // XTQMODKEYS and XTSMGRAPHICS.
        b'm' | b'S' => first == Some(b'?'),
        // DECREQTPARM, and DECRQCRA (`CSI … * y`).
        b'x' => true,
        b'y' => params.ends_with(b"*"),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::*;

    fn filtered(output: &[u8]) -> String {
        String::from_utf8_lossy(&Filter::default().feed(output)).into_owned()
    }

    /// `output` fed a byte at a time, as the worst split across chunks.
    fn filtered_bytewise(output: &[u8]) -> String {
        let mut filter = Filter::default();
        let out: Vec<u8> = output
            .iter()
            .flat_map(|byte| filter.feed(std::slice::from_ref(byte)))
            .collect();
        String::from_utf8_lossy(&out).into_owned()
    }

    #[test]
    fn queries_are_left_out_and_everything_else_passes_unchanged() {
        let queries: &[&[u8]] = &[
            b"\x1b[c",
            b"\x1b[0c",
            b"\x1b[>c",
            b"\x1b[=0c",
            b"\x1b[5n",
            b"\x1b[6n",
            b"\x1b[?6n",
            b"\x1b[?996n",
            b"\x1b[?2026$p",
            b"\x1b[4$p",
            b"\x1b[?u",
            b"\x1b[>q",
            b"\x1b[>0q",
            b"\x1b[14t",
            b"\x1b[18t",
            b"\x1b[?4m",
            b"\x1b[?1;1;0S",
            b"\x1bZ",
            b"\x1b]11;?\x07",
            b"\x1b]10;?\x1b\\",
            b"\x1b]4;1;?\x07",
            b"\x1bP$qm\x1b\\",
            b"\x1bP+q544e\x1b\\",
            b"\x05",
        ];
        for query in queries {
            let output = [b"a".as_slice(), query, b"b"].concat();
            assert_eq!(
                filtered(&output),
                "ab",
                "{:?}",
                String::from_utf8_lossy(query)
            );
            assert_eq!(
                filtered_bytewise(&output),
                "ab",
                "{:?}",
                String::from_utf8_lossy(query)
            );
        }
        let kept: &[&[u8]] = &[
            b"\x1b[1;31mred\x1b[0m",
            b"\x1b[2J\x1b[H",
            b"\x1b[?1049h\x1b[?2004h",
            b"\x1b[>1u\x1b[<u\x1b[u",
            b"\x1b[2 q",
            b"\x1b[>4;1m",
            b"\x1b[>1n",
            b"\x1b[8;24;80t\x1b[22;0t",
            b"\x1b]0;title\x07",
            b"\x1b]7;file://host/tmp\x1b\\",
            b"\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\",
            b"\x1b]133;A\x07",
            b"\x1b]7501;state=working\x07",
            b"\x1b]9;4;1;40\x07",
            b"\x1b]11;rgb:0000/0000/0000\x07",
            b"\x1b]4;1;rgb:ff/00/00\x07",
            b"\x1b(B\x1b=\x1b>",
            b"\x1bPq#0;2;0;0;0#0~~\x1b\\",
            "héllo ✓".as_bytes(),
        ];
        for sequence in kept {
            let text = String::from_utf8_lossy(sequence).into_owned();
            assert_eq!(filtered(sequence), text);
            assert_eq!(filtered_bytewise(sequence), text);
        }
    }

    #[test]
    fn clipboard_writes_notifications_and_graphics_are_left_out() {
        for sequence in [
            b"\x1b]52;c;aGVsbG8=\x07".as_slice(),
            b"\x1b]52;c;?\x1b\\",
            b"\x1b]9;Build finished\x07",
            b"\x1b]777;notify;Done;Tests passed\x1b\\",
            b"\x1b_Gf=24,s=10,v=20;AAAA\x1b\\",
            b"\x1b_Ga=q,i=1;AAAA\x1b\\",
        ] {
            let output = [b"<".as_slice(), sequence, b">"].concat();
            assert_eq!(filtered(&output), "<>");
            assert_eq!(filtered_bytewise(&output), "<>");
        }
    }

    #[test]
    fn a_long_payload_streams_through_without_being_held() {
        let mut filter = Filter::default();
        let payload = "x".repeat(HOLD * 3);
        let start = filter.feed(format!("\x1b]1337;File=:{payload}").as_bytes());
        assert!(start.len() > HOLD, "it isn't held");
        let end = filter.feed(b"\x07after");
        assert_eq!(end, b"\x07after");

        // A dropped one isn't held either, and what follows it passes.
        let mut filter = Filter::default();
        assert_eq!(filter.feed(format!("\x1b]52;c;{payload}").as_bytes()), b"");
        assert!(filter.held.len() <= 2);
        assert_eq!(filter.feed(b"\x1b\\after"), b"after");
    }

    #[test]
    fn an_escape_inside_a_sequence_starts_another() {
        // A CSI cut short by another escape: both pass, the second whole.
        assert_eq!(filtered(b"\x1b[1\x1b[31mred"), "\x1b[1\x1b[31mred");
        assert_eq!(filtered(b"\x1b[1\x1b[6nafter"), "\x1b[1after");
    }
}
