//! One terminal's screen in libghostty-vt. The holder's terminal is the authority: a program's
//! output is written into it, it alone answers the program's queries, and what else the output
//! does comes back as Rex's events. A replica restored from its snapshot, as a client's is, has
//! no callbacks and answers nothing.

use std::collections::BTreeMap;
use std::ffi::c_void;
use std::ptr;

use crate::event::BlockedKind;
use crate::event::Command;
use crate::event::Event;
use crate::event::ProgramState;
use crate::event::ProgramStatus;
use crate::event::ProgressState;
use crate::event::Reason;
use crate::event::Size;
use crate::ffi;

/// A libghostty-vt call that didn't succeed.
#[derive(Debug, thiserror::Error)]
#[error("libghostty-vt: {call} returned {code}")]
pub struct Error {
    call: &'static str,
    code: ffi::GhosttyResult,
}

fn check(call: &'static str, code: ffi::GhosttyResult) -> Result<(), Error> {
    if code == ffi::GHOSTTY_SUCCESS {
        Ok(())
    } else {
        Err(Error { call, code })
    }
}

/// What the formatter writes, as Rex's `format` names it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Format {
    /// The characters alone.
    Text,
    /// VT sequences that draw the screen again, with its styles, cursor, modes, palette and
    /// keyboard state, which any terminal can restore from.
    Vt,
    /// HTML that keeps the styles.
    Html,
}

/// How the formatter writes it, as Rex's `format` takes it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Formatting {
    /// Trailing whitespace trimmed from lines, and trailing blank lines dropped.
    pub trim: bool,
    /// Lines the terminal wrapped joined again.
    pub unwrap: bool,
}

impl Formatting {
    pub const TRIMMED: Self = Self {
        trim: true,
        unwrap: false,
    };
}

/// What writing to the terminal produced besides the screen.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Effects {
    /// Replies to the program's queries, for the PTY.
    pub replies: Vec<u8>,
    pub events: Vec<Event>,
}

/// Bytes of a sequence split across writes that a snapshot carries, which snapshots need tracked
/// from the first byte.
const CONTINUATION_MAX_BYTES: usize = 64 * 1024;
/// How much history the terminal keeps.
const SCROLLBACK_MAX_BYTES: usize = 16 * 1024 * 1024;
/// The cell size size reports give, in pixels, since the holder draws nothing.
const CELL: (u32, u32) = (8, 16);

/// A terminal's screen and history.
pub struct Terminal {
    raw: ffi::GhosttyTerminal,
    /// The authority's: what callbacks collect between writes. A replica has none.
    state: Option<Box<State>>,
}

// libghostty-vt's terminal is used from one thread at a time: the holder keeps it under a lock.
unsafe impl Send for Terminal {}

#[derive(Default)]
struct State {
    replies: Vec<u8>,
    events: Vec<Event>,
    size: Option<Size>,
    /// OSC 7501 records by id, "" the root, which libghostty-vt leaves to the embedder to keep.
    records: BTreeMap<String, ProgramStatus>,
    command: Command,
}

impl Terminal {
    /// The authority: the holder's terminal, which answers queries and reports effects.
    pub fn new(cols: u16, rows: u16) -> Result<Self, Error> {
        let mut raw: ffi::GhosttyTerminal = ptr::null_mut();
        check("ghostty_terminal_new", unsafe {
            ffi::ghostty_terminal_new(ptr::null(), &mut raw, cols, rows)
        })?;
        let mut terminal = Self {
            raw,
            state: Some(Box::new(State {
                size: Some(Size { cols, rows }),
                ..State::default()
            })),
        };
        let userdata = terminal
            .state
            .as_deref_mut()
            .map_or(ptr::null_mut(), |state| state as *mut State as *mut c_void);
        let continuation = CONTINUATION_MAX_BYTES;
        let scrollback = SCROLLBACK_MAX_BYTES;
        let options: [(ffi::GhosttyTerminalOption, *const c_void); 15] = [
            (ffi::GHOSTTY_TERMINAL_OPT_USERDATA, userdata),
            (
                ffi::GHOSTTY_TERMINAL_OPT_WRITE_PTY,
                on_write_pty as *const c_void,
            ),
            (ffi::GHOSTTY_TERMINAL_OPT_BELL, on_bell as *const c_void),
            (
                ffi::GHOSTTY_TERMINAL_OPT_TITLE_CHANGED,
                on_title as *const c_void,
            ),
            (
                ffi::GHOSTTY_TERMINAL_OPT_PWD_CHANGED,
                on_pwd as *const c_void,
            ),
            (ffi::GHOSTTY_TERMINAL_OPT_SIZE, on_size as *const c_void),
            (
                ffi::GHOSTTY_TERMINAL_OPT_DEVICE_ATTRIBUTES,
                on_device_attributes as *const c_void,
            ),
            (
                ffi::GHOSTTY_TERMINAL_OPT_CLIPBOARD_WRITE,
                on_clipboard_write as *const c_void,
            ),
            (
                ffi::GHOSTTY_TERMINAL_OPT_CLIPBOARD_READ,
                on_clipboard_read as *const c_void,
            ),
            (
                ffi::GHOSTTY_TERMINAL_OPT_DESKTOP_NOTIFICATION,
                on_notification as *const c_void,
            ),
            (
                ffi::GHOSTTY_TERMINAL_OPT_PROGRESS_REPORT,
                on_progress as *const c_void,
            ),
            (
                ffi::GHOSTTY_TERMINAL_OPT_PROGRAM_STATUS,
                on_program_status as *const c_void,
            ),
            (
                ffi::GHOSTTY_TERMINAL_OPT_SEMANTIC_PROMPT,
                on_semantic_prompt as *const c_void,
            ),
            (ffi::GHOSTTY_TERMINAL_OPT_RESET, on_reset as *const c_void),
            (
                ffi::GHOSTTY_TERMINAL_OPT_CONTINUATION_MAX_BYTES,
                &continuation as *const usize as *const c_void,
            ),
        ];
        for (option, value) in options {
            check("ghostty_terminal_set", unsafe {
                ffi::ghostty_terminal_set(raw, option, value)
            })?;
        }
        check("ghostty_terminal_set", unsafe {
            ffi::ghostty_terminal_set(
                raw,
                ffi::GHOSTTY_TERMINAL_OPT_SCROLLBACK_MAX_BYTES,
                &scrollback as *const usize as *const c_void,
            )
        })?;
        Ok(terminal)
    }

    /// A replica of the terminal a snapshot was taken of, as a client restores one: no callbacks,
    /// so it answers nothing.
    pub fn restore(snapshot: &[u8]) -> Result<Self, Error> {
        let mut decoder: ffi::GhosttySnapshotDecoder = ptr::null_mut();
        check("ghostty_snapshot_decoder_new_buf", unsafe {
            ffi::ghostty_snapshot_decoder_new_buf(
                ptr::null(),
                &mut decoder,
                snapshot.as_ptr(),
                snapshot.len(),
            )
        })?;
        let mut raw: ffi::GhosttyTerminal = ptr::null_mut();
        let decoded = check("ghostty_snapshot_decoder_decode", unsafe {
            ffi::ghostty_snapshot_decoder_decode(decoder, &mut raw)
        });
        unsafe { ffi::ghostty_snapshot_decoder_free(decoder) };
        decoded?;
        Ok(Self { raw, state: None })
    }

    /// Names the terminfo entry the program runs under, which XTGETTCAP reports.
    pub fn set_terminfo_name(&mut self, name: &str) -> Result<(), Error> {
        let name = ffi::GhosttyString {
            ptr: name.as_ptr(),
            len: name.len(),
        };
        check("ghostty_terminal_set", unsafe {
            ffi::ghostty_terminal_set(
                self.raw,
                ffi::GHOSTTY_TERMINAL_OPT_TERMINFO_NAME,
                &name as *const ffi::GhosttyString as *const c_void,
            )
        })
    }

    /// Writes a program's output, as the PTY gave it.
    pub fn write(&mut self, bytes: &[u8]) -> Effects {
        unsafe { ffi::ghostty_terminal_vt_write(self.raw, bytes.as_ptr(), bytes.len()) };
        self.take_effects()
    }

    /// Takes the new size, as the PTY does. A program that asked (mode 2048) is told in-band.
    pub fn resize(&mut self, cols: u16, rows: u16) -> Result<Effects, Error> {
        if let Some(state) = self.state.as_deref_mut() {
            state.size = Some(Size { cols, rows });
        }
        check("ghostty_terminal_resize", unsafe {
            ffi::ghostty_terminal_resize(self.raw, cols, rows, CELL.0, CELL.1)
        })?;
        Ok(self.take_effects())
    }

    /// The program exited, which ends its `working` and `blocked` OSC 7501 records.
    pub fn exited(&mut self) -> Vec<Event> {
        let Some(state) = self.state.as_deref_mut() else {
            return Vec::new();
        };
        end_activity(state, Reason::Exit);
        std::mem::take(&mut state.events)
    }

    fn take_effects(&mut self) -> Effects {
        let (title, pwd) = (self.title(), self.pwd());
        let Some(state) = self.state.as_deref_mut() else {
            return Effects::default();
        };
        let mut events = std::mem::take(&mut state.events);
        // Callbacks only say the title or directory changed; they're read once the write returns.
        for event in &mut events {
            match event {
                Event::TitleChanged { title: value, .. } => value.clone_from(&title),
                Event::PwdChanged { pwd: value, .. } => value.clone_from(&pwd),
                _ => {}
            }
        }
        Effects {
            replies: std::mem::take(&mut state.replies),
            events,
        }
    }

    pub fn size(&self) -> Size {
        Size {
            cols: self.get(ffi::GHOSTTY_TERMINAL_DATA_COLS),
            rows: self.get(ffi::GHOSTTY_TERMINAL_DATA_ROWS),
        }
    }

    pub fn title(&self) -> String {
        self.get_string(ffi::GHOSTTY_TERMINAL_DATA_TITLE)
    }

    /// The directory the program last reported (OSC 7), as the URL it sent.
    pub fn pwd(&self) -> String {
        self.get_string(ffi::GHOSTTY_TERMINAL_DATA_PWD)
    }

    pub fn program_status(&self) -> Vec<ProgramStatus> {
        self.state
            .as_deref()
            .map(|state| state.records.values().cloned().collect())
            .unwrap_or_default()
    }

    pub fn command(&self) -> Command {
        self.state
            .as_deref()
            .map(|state| state.command.clone())
            .unwrap_or_default()
    }

    fn get(&self, data: ffi::GhosttyTerminalData) -> u16 {
        let mut value: u16 = 0;
        unsafe { ffi::ghostty_terminal_get(self.raw, data, &mut value as *mut u16 as *mut c_void) };
        value
    }

    fn get_string(&self, data: ffi::GhosttyTerminalData) -> String {
        let mut value = ffi::GhosttyString {
            ptr: ptr::null(),
            len: 0,
        };
        let code = unsafe {
            ffi::ghostty_terminal_get(
                self.raw,
                data,
                &mut value as *mut ffi::GhosttyString as *mut c_void,
            )
        };
        if code == ffi::GHOSTTY_SUCCESS {
            string(&value)
        } else {
            String::new()
        }
    }

    /// The screen and its history through the formatter.
    pub fn format(&self, format: Format, formatting: Formatting) -> Result<String, Error> {
        let styled = format != Format::Text;
        let options = ffi::GhosttyFormatterTerminalOptions {
            size: size_of::<ffi::GhosttyFormatterTerminalOptions>(),
            emit: match format {
                Format::Text => ffi::GHOSTTY_FORMATTER_FORMAT_PLAIN,
                Format::Vt => ffi::GHOSTTY_FORMATTER_FORMAT_VT,
                Format::Html => ffi::GHOSTTY_FORMATTER_FORMAT_HTML,
            },
            unwrap: formatting.unwrap,
            trim: formatting.trim,
            extra: ffi::GhosttyFormatterTerminalExtra {
                size: size_of::<ffi::GhosttyFormatterTerminalExtra>(),
                palette: styled,
                modes: styled,
                scrolling_region: styled,
                tabstops: styled,
                pwd: styled,
                keyboard: styled,
                screen: ffi::GhosttyFormatterScreenExtra {
                    size: size_of::<ffi::GhosttyFormatterScreenExtra>(),
                    cursor: styled,
                    style: styled,
                    hyperlink: styled,
                    protection: styled,
                    kitty_keyboard: styled,
                    charsets: styled,
                },
            },
            selection: ptr::null(),
        };
        let mut formatter: ffi::GhosttyFormatter = ptr::null_mut();
        check("ghostty_formatter_terminal_new", unsafe {
            ffi::ghostty_formatter_terminal_new(ptr::null(), &mut formatter, self.raw, options)
        })?;
        let mut out: *mut u8 = ptr::null_mut();
        let mut len = 0;
        let formatted = check("ghostty_formatter_format_alloc", unsafe {
            ffi::ghostty_formatter_format_alloc(formatter, ptr::null(), &mut out, &mut len)
        });
        unsafe { ffi::ghostty_formatter_free(formatter) };
        formatted?;
        Ok(String::from_utf8_lossy(&take(out, len)).into_owned())
    }

    /// The whole terminal as a snapshot, which a libghostty-vt of the same codec restores.
    pub fn snapshot(&self) -> Result<Vec<u8>, Error> {
        let mut out: *mut u8 = ptr::null_mut();
        let mut len = 0;
        check("ghostty_snapshot_encode_alloc", unsafe {
            ffi::ghostty_snapshot_encode_alloc(self.raw, ptr::null(), &mut out, &mut len)
        })?;
        Ok(take(out, len))
    }
}

impl Drop for Terminal {
    fn drop(&mut self) {
        unsafe { ffi::ghostty_terminal_free(self.raw) }
    }
}

/// Copies and frees a buffer libghostty-vt allocated.
fn take(out: *mut u8, len: usize) -> Vec<u8> {
    if out.is_null() {
        return Vec::new();
    }
    let bytes = unsafe { std::slice::from_raw_parts(out, len) }.to_vec();
    unsafe { ffi::ghostty_free(ptr::null(), out, len) };
    bytes
}

fn string(value: &ffi::GhosttyString) -> String {
    if value.ptr.is_null() || value.len == 0 {
        return String::new();
    }
    String::from_utf8_lossy(unsafe { std::slice::from_raw_parts(value.ptr, value.len) })
        .into_owned()
}

fn optional(value: &ffi::GhosttyString) -> Option<String> {
    Some(string(value)).filter(|value| !value.is_empty())
}

/// The Ghostty commit this holder's libghostty-vt was built from (`ghostty.toml`).
pub const GHOSTTY_COMMIT: &str = env!("WEAVE_GHOSTTY_COMMIT");

/// Names this build's snapshots: the Ghostty commit and the snapshot format's version, read from
/// a snapshot's envelope (8 bytes of magic, then a little-endian u16). libghostty-vt reports the
/// same version at every commit, so only the commit tells two builds apart.
pub fn codec() -> Result<String, Error> {
    let snapshot = Terminal::new(2, 2)?.snapshot()?;
    let version = match snapshot.get(8..10) {
        Some(&[low, high]) => u16::from_le_bytes([low, high]),
        _ => 0,
    };
    Ok(format!("ghostty {GHOSTTY_COMMIT} snapshot {version}"))
}

/// Ends `working` and `blocked` records, as OSC 7501 asks at a new prompt and when the program
/// exits.
fn end_activity(state: &mut State, reason: Reason) {
    let ids: Vec<String> = state
        .records
        .iter()
        .filter(|(_, record)| matches!(record.state, ProgramState::Working | ProgramState::Blocked))
        .map(|(id, _)| id.clone())
        .collect();
    if ids.is_empty() {
        return;
    }
    for id in &ids {
        state.records.remove(id);
    }
    state
        .events
        .push(Event::ProgramStatusRemoved { ids, reason });
}

// Callbacks run inside `ghostty_terminal_vt_write`, on the writing thread, with the userdata the
// authority set: its `State`, which nothing else touches until the write returns.

fn state<'a>(userdata: *mut c_void) -> &'a mut State {
    unsafe { &mut *(userdata as *mut State) }
}

unsafe extern "C" fn on_write_pty(
    _: ffi::GhosttyTerminal,
    userdata: *mut c_void,
    data: *const u8,
    len: usize,
) {
    let bytes = unsafe { std::slice::from_raw_parts(data, len) };
    state(userdata).replies.extend_from_slice(bytes);
}

unsafe extern "C" fn on_bell(_: ffi::GhosttyTerminal, userdata: *mut c_void) {
    state(userdata).events.push(Event::Bell {});
}

unsafe extern "C" fn on_title(_: ffi::GhosttyTerminal, userdata: *mut c_void) {
    state(userdata).events.push(Event::TitleChanged {
        title: String::new(),
        owner: None,
    });
}

unsafe extern "C" fn on_pwd(_: ffi::GhosttyTerminal, userdata: *mut c_void) {
    state(userdata).events.push(Event::PwdChanged {
        pwd: String::new(),
        owner: None,
    });
}

unsafe extern "C" fn on_size(
    _: ffi::GhosttyTerminal,
    userdata: *mut c_void,
    out: *mut ffi::GhosttySizeReportSize,
) -> bool {
    let Some(size) = state(userdata).size else {
        return false;
    };
    let out = unsafe { &mut *out };
    out.columns = size.cols;
    out.rows = size.rows;
    out.cell_width = CELL.0;
    out.cell_height = CELL.1;
    true
}

/// Answers as Ghostty does: a VT220 with ANSI color (`CSI ? 62 ; 22 c`), firmware 10.
unsafe extern "C" fn on_device_attributes(
    _: ffi::GhosttyTerminal,
    _: *mut c_void,
    out: *mut ffi::GhosttyDeviceAttributes,
) -> bool {
    let out = unsafe { &mut *out };
    out.primary.conformance_level = ffi::GHOSTTY_DA_CONFORMANCE_VT220 as u16;
    out.primary.features[0] = ffi::GHOSTTY_DA_FEATURE_ANSI_COLOR as u16;
    out.primary.num_features = 1;
    out.secondary.device_type = ffi::GHOSTTY_DA_DEVICE_TYPE_VT220 as u16;
    out.secondary.firmware_version = 10;
    out.secondary.rom_cartridge = 0;
    out.tertiary.unit_id = 0;
    true
}

unsafe extern "C" fn on_clipboard_write(
    _: ffi::GhosttyTerminal,
    userdata: *mut c_void,
    write: *const ffi::GhosttyClipboardWrite,
) {
    let write = unsafe { &*write };
    let contents = if write.contents.is_null() {
        &[][..]
    } else {
        unsafe { std::slice::from_raw_parts(write.contents, write.contents_len) }
    };
    let text = contents
        .iter()
        .find(|content| content.mime.len == 0 || string(&content.mime).starts_with("text/plain"))
        .map(|content| string(&content.data))
        .unwrap_or_default();
    state(userdata)
        .events
        .push(Event::ClipboardWritten { text });
    let reply = ffi::GhosttyClipboardWriteReply {
        size: size_of::<ffi::GhosttyClipboardWriteReply>(),
        result: ffi::GHOSTTY_CLIPBOARD_WRITE_RESULT_SUCCESS,
        remember: false,
    };
    if let Some(reply_fn) = write.reply {
        unsafe { reply_fn(write, &reply) }
    }
}

/// Clipboard reads are refused (ADR 0022).
unsafe extern "C" fn on_clipboard_read(
    _: ffi::GhosttyTerminal,
    _: *mut c_void,
    read: *const ffi::GhosttyClipboardRead,
) {
    let read = unsafe { &*read };
    let reply = ffi::GhosttyClipboardReadReply {
        size: size_of::<ffi::GhosttyClipboardReadReply>(),
        result: ffi::GHOSTTY_CLIPBOARD_READ_RESULT_DENIED,
        ..Default::default()
    };
    if let Some(reply_fn) = read.reply {
        unsafe { reply_fn(read, &reply) }
    }
}

unsafe extern "C" fn on_notification(
    _: ffi::GhosttyTerminal,
    userdata: *mut c_void,
    notification: *const ffi::GhosttyTerminalDesktopNotification,
) {
    let notification = unsafe { &*notification };
    state(userdata).events.push(Event::DesktopNotification {
        title: string(&notification.title),
        body: string(&notification.body),
    });
}

unsafe extern "C" fn on_progress(
    _: ffi::GhosttyTerminal,
    userdata: *mut c_void,
    report: *const ffi::GhosttyTerminalProgressReport,
) {
    let report = unsafe { &*report };
    let progress_state = match report.state {
        ffi::GHOSTTY_TERMINAL_PROGRESS_STATE_REMOVE => ProgressState::Remove,
        ffi::GHOSTTY_TERMINAL_PROGRESS_STATE_SET => ProgressState::Set,
        ffi::GHOSTTY_TERMINAL_PROGRESS_STATE_ERROR => ProgressState::Error,
        ffi::GHOSTTY_TERMINAL_PROGRESS_STATE_PAUSE => ProgressState::Pause,
        _ => ProgressState::Indeterminate,
    };
    state(userdata).events.push(Event::ProgressReport {
        state: progress_state,
        progress: u8::try_from(report.progress).ok(),
    });
}

unsafe extern "C" fn on_program_status(
    _: ffi::GhosttyTerminal,
    userdata: *mut c_void,
    report: *const ffi::GhosttyTerminalProgramStatus,
) {
    let report = unsafe { &*report };
    let state = state(userdata);
    let id = string(&report.id);
    let record_state = match report.state {
        ffi::GHOSTTY_PROGRAM_STATUS_STATE_CLEAR => {
            // The record and every record below it, or all of them without an id.
            let prefix = format!("{id}/");
            let ids: Vec<String> = state
                .records
                .keys()
                .filter(|key| id.is_empty() || **key == id || key.starts_with(&prefix))
                .cloned()
                .collect();
            if ids.is_empty() {
                return;
            }
            for key in &ids {
                state.records.remove(key);
            }
            state.events.push(Event::ProgramStatusRemoved {
                ids,
                reason: Reason::Clear,
            });
            return;
        }
        ffi::GHOSTTY_PROGRAM_STATUS_STATE_IDLE => ProgramState::Idle,
        ffi::GHOSTTY_PROGRAM_STATUS_STATE_WORKING => ProgramState::Working,
        ffi::GHOSTTY_PROGRAM_STATUS_STATE_DONE => ProgramState::Done,
        ffi::GHOSTTY_PROGRAM_STATUS_STATE_BLOCKED => ProgramState::Blocked,
        _ => ProgramState::Error,
    };
    let record = ProgramStatus {
        id: Some(id.clone()).filter(|id| !id.is_empty()),
        state: record_state,
        kind: match report.kind {
            ffi::GHOSTTY_PROGRAM_STATUS_KIND_PERMISSION => Some(BlockedKind::Permission),
            ffi::GHOSTTY_PROGRAM_STATUS_KIND_QUESTION => Some(BlockedKind::Question),
            ffi::GHOSTTY_PROGRAM_STATUS_KIND_AUTH => Some(BlockedKind::Auth),
            _ => None,
        },
        progress: u8::try_from(report.progress).ok(),
        app: optional(&report.app),
        title: optional(&report.title),
        msg: optional(&report.message),
    };
    state.records.insert(id.clone(), record.clone());
    state.events.push(Event::ProgramStatusChanged {
        id,
        record,
        reason: Reason::Report,
    });
}

unsafe extern "C" fn on_semantic_prompt(
    _: ffi::GhosttyTerminal,
    userdata: *mut c_void,
    event: *const ffi::GhosttyTerminalSemanticPrompt,
) {
    let event = unsafe { &*event };
    let state = state(userdata);
    let command = match event.kind {
        ffi::GHOSTTY_SEMANTIC_PROMPT_PROMPT_START => {
            if event.prompt_kind == ffi::GHOSTTY_SEMANTIC_PROMPT_PROMPT_PRIMARY {
                end_activity(state, Reason::Prompt);
            }
            return;
        }
        ffi::GHOSTTY_SEMANTIC_PROMPT_OUTPUT_START => Command {
            running: true,
            command: optional(&event.command),
            exit_code: None,
        },
        ffi::GHOSTTY_SEMANTIC_PROMPT_COMMAND_END => Command {
            running: false,
            command: None,
            exit_code: event.has_exit_code.then_some(event.exit_code),
        },
        _ => return,
    };
    if state.command != command {
        state.command = command.clone();
        state.events.push(Event::CommandChanged(command));
    }
}

/// A full reset (RIS) cleared the title and directory without their callbacks, and ends any
/// command; libghostty-vt has already reported the program status records it removed.
unsafe extern "C" fn on_reset(_: ffi::GhosttyTerminal, userdata: *mut c_void) {
    let state = state(userdata);
    state.events.push(Event::TitleChanged {
        title: String::new(),
        owner: None,
    });
    state.events.push(Event::PwdChanged {
        pwd: String::new(),
        owner: None,
    });
    if state.command != Command::default() {
        state.command = Command::default();
        state.events.push(Event::CommandChanged(Command::default()));
    }
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::*;
    use crate::event::ProgramStatus;

    fn terminal() -> Terminal {
        Terminal::new(40, 8).unwrap()
    }

    #[test]
    fn formats_what_was_written() {
        let mut terminal = Terminal::new(20, 5).unwrap();
        terminal.write(b"hello\r\n\x1b[1;31mworld\x1b[0m");
        assert_eq!(
            terminal.format(Format::Text, Formatting::TRIMMED).unwrap(),
            "hello\nworld"
        );
    }

    #[test]
    fn a_terminal_restored_from_vt_matches() {
        let mut terminal = Terminal::new(30, 6).unwrap();
        terminal.write(b"one\r\n\x1b[4mtwo\x1b[0m\r\n\x1b]0;title\x07three \x1b[38;5;208mfour");
        let mut restored = Terminal::new(30, 6).unwrap();
        restored.write(
            terminal
                .format(Format::Vt, Formatting::TRIMMED)
                .unwrap()
                .as_bytes(),
        );
        assert_eq!(
            restored.format(Format::Vt, Formatting::TRIMMED).unwrap(),
            terminal.format(Format::Vt, Formatting::TRIMMED).unwrap()
        );
        assert_eq!(
            restored.format(Format::Text, Formatting::TRIMMED).unwrap(),
            "one\ntwo\nthree four"
        );
    }

    #[test]
    fn a_replica_restored_from_a_snapshot_matches_with_its_history() {
        let mut terminal = Terminal::new(20, 4).unwrap();
        for line in 1..=200 {
            terminal.write(format!("line {line}\r\n").as_bytes());
        }
        terminal.write(b"\x1b[1;32mprompt\x1b[0m $ ");
        let replica = Terminal::restore(&terminal.snapshot().unwrap()).unwrap();
        assert_eq!(
            replica.format(Format::Vt, Formatting::TRIMMED).unwrap(),
            terminal.format(Format::Vt, Formatting::TRIMMED).unwrap()
        );
        let text = replica.format(Format::Text, Formatting::TRIMMED).unwrap();
        assert!(text.starts_with("line 1\nline 2\n"), "{text}");
        assert!(text.ends_with("line 200\nprompt $"), "{text}");
    }

    #[test]
    fn the_authority_answers_queries_and_a_replica_doesnt() {
        let mut terminal = terminal();
        assert_eq!(terminal.write(b"\x1b[c").replies, b"\x1b[?62;22c");
        assert_eq!(terminal.write(b"\x1b[>c").replies, b"\x1b[>1;10;0c");
        let mut replica = Terminal::restore(&terminal.snapshot().unwrap()).unwrap();
        assert_eq!(replica.write(b"\x1b[c"), Effects::default());
    }

    #[test]
    fn reports_its_size_in_band_once_asked() {
        let mut terminal = terminal();
        terminal.write(b"\x1b[?2048h");
        let effects = terminal.resize(100, 30).unwrap();
        assert_eq!(
            String::from_utf8(effects.replies).unwrap(),
            "\x1b[48;30;100;480;800t"
        );
        assert_eq!(
            terminal.size(),
            Size {
                cols: 100,
                rows: 30
            }
        );
    }

    #[test]
    fn title_directory_bell_and_clipboard_become_events() {
        let mut terminal = terminal();
        let effects = terminal
            .write(b"\x1b]0;build\x07\x1b]7;file://mac/Users/me/src\x07\x07\x1b]52;c;aGVsbG8=\x07");
        assert_eq!(
            effects.events,
            [
                Event::TitleChanged {
                    title: "build".into(),
                    owner: None
                },
                Event::PwdChanged {
                    pwd: "file://mac/Users/me/src".into(),
                    owner: None
                },
                Event::Bell {},
                Event::ClipboardWritten {
                    text: "hello".into()
                },
            ]
        );
        assert_eq!(terminal.title(), "build");
        assert_eq!(terminal.pwd(), "file://mac/Users/me/src");
    }

    #[test]
    fn clipboard_reads_are_refused() {
        let mut terminal = terminal();
        terminal.write(b"\x1b]52;c;aGVsbG8=\x07");
        let effects = terminal.write(b"\x1b]52;c;?\x07");
        assert!(!String::from_utf8_lossy(&effects.replies).contains("aGVsbG8="));
        assert_eq!(effects.events, []);
    }

    #[test]
    fn notifications_and_progress_become_events() {
        let mut terminal = terminal();
        let effects = terminal.write(b"\x1b]777;notify;Done;Tests passed\x07\x1b]9;4;1;40\x07");
        assert_eq!(
            effects.events,
            [
                Event::DesktopNotification {
                    title: "Done".into(),
                    body: "Tests passed".into()
                },
                Event::ProgressReport {
                    state: ProgressState::Set,
                    progress: Some(40)
                },
            ]
        );
    }

    #[test]
    fn program_status_records_last_until_a_prompt_or_exit_ends_them() {
        let mut terminal = terminal();
        let effects = terminal.write(
            b"\x1b]7501;state=working:id=build:app=make:progress=10\x07\
              \x1b]7501;state=done:id=lint\x07",
        );
        assert_eq!(effects.events.len(), 2);
        let working = ProgramStatus {
            id: Some("build".into()),
            state: ProgramState::Working,
            kind: None,
            progress: Some(10),
            app: Some("make".into()),
            title: None,
            msg: None,
        };
        assert_eq!(
            effects.events[0],
            Event::ProgramStatusChanged {
                id: "build".into(),
                record: working,
                reason: Reason::Report
            }
        );
        assert_eq!(terminal.program_status().len(), 2);

        // A new prompt ends the working record; the done one stays.
        let effects = terminal.write(b"\x1b]133;A\x07");
        assert_eq!(
            effects.events,
            [Event::ProgramStatusRemoved {
                ids: vec!["build".into()],
                reason: Reason::Prompt
            }]
        );
        assert_eq!(terminal.program_status().len(), 1);

        terminal.write(b"\x1b]7501;state=blocked:kind=question\x07");
        assert_eq!(
            terminal.exited(),
            [Event::ProgramStatusRemoved {
                ids: vec![String::new()],
                reason: Reason::Exit
            }]
        );
    }

    #[test]
    fn osc_133_says_when_a_command_runs_and_how_it_ended() {
        let mut terminal = terminal();
        let effects = terminal.write(b"\x1b]133;A\x07$ \x1b]133;B\x07make\r\n\x1b]133;C\x07");
        assert_eq!(
            effects.events,
            [Event::CommandChanged(Command {
                running: true,
                command: None,
                exit_code: None
            })]
        );
        let effects = terminal.write(b"done\r\n\x1b]133;D;2\x07");
        assert_eq!(
            effects.events,
            [Event::CommandChanged(Command {
                running: false,
                command: None,
                exit_code: Some(2)
            })]
        );
        assert_eq!(terminal.command().exit_code, Some(2));
    }

    #[test]
    fn a_full_reset_clears_the_title_directory_and_progress() {
        let mut terminal = terminal();
        terminal.write(b"\x1b]0;build\x07\x1b]7;file://mac/tmp\x07");
        let effects = terminal.write(b"\x1bc");
        assert_eq!(
            effects.events,
            [
                Event::ProgressReport {
                    state: ProgressState::Remove,
                    progress: None
                },
                Event::TitleChanged {
                    title: String::new(),
                    owner: None
                },
                Event::PwdChanged {
                    pwd: String::new(),
                    owner: None
                },
            ]
        );
    }

    #[test]
    fn the_codec_names_the_pinned_commit() {
        assert_eq!(
            codec().unwrap(),
            format!("ghostty {GHOSTTY_COMMIT} snapshot 1")
        );
        assert_eq!(GHOSTTY_COMMIT.len(), 40);
    }
}
