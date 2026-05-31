use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, PtySize};
use serde::Deserialize;
use std::collections::HashMap;
use std::ffi::{c_char, CString};
use std::io::{Read, Write};
use std::ptr;
use std::slice;
use std::sync::mpsc::{channel, Receiver, TryRecvError};
use std::sync::Mutex;
use std::thread;

const READ_NONE: i32 = 0;
const READ_DATA: i32 = 1;
const READ_EXIT: i32 = 2;
const READ_ERROR: i32 = -1;

#[derive(Deserialize)]
struct SpawnConfig {
    file: String,
    args: Vec<String>,
    cwd: String,
    env: HashMap<String, String>,
    cols: u16,
    rows: u16,
}

struct ExitMessage {
    code: i32,
}

pub struct PortalPty {
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    killer: Mutex<Option<Box<dyn ChildKiller + Send + Sync>>>,
    output_rx: Mutex<Receiver<Vec<u8>>>,
    exit_rx: Mutex<Receiver<ExitMessage>>,
    exit_status: Mutex<Option<ExitMessage>>,
    exit_reported: Mutex<bool>,
    pid: u32,
    master: Box<dyn portable_pty::MasterPty + Send>,
}

fn set_error(error_out: *mut *mut c_char, message: impl ToString) {
    if error_out.is_null() {
        return;
    }

    let sanitized = message.to_string().replace('\0', "\\0");
    let c_string =
        CString::new(sanitized).unwrap_or_else(|_| CString::new("unknown error").unwrap());
    unsafe {
        *error_out = c_string.into_raw();
    }
}

fn read_config(config_ptr: *const u8, config_len: usize) -> Result<SpawnConfig, String> {
    if config_ptr.is_null() {
        return Err("spawn config pointer is null".to_string());
    }

    let bytes = unsafe { slice::from_raw_parts(config_ptr, config_len) };
    serde_json::from_slice(bytes).map_err(|error| format!("invalid spawn config: {error}"))
}

fn write_data(data_out: *mut *mut u8, len_out: *mut usize, data: Vec<u8>) {
    if data_out.is_null() || len_out.is_null() {
        return;
    }

    let len = data.len();
    let ptr = Box::into_raw(data.into_boxed_slice()) as *mut u8;
    unsafe {
        *data_out = ptr;
        *len_out = len;
    }
}

#[no_mangle]
pub extern "C" fn weave_pty_create(
    config_ptr: *const u8,
    config_len: usize,
    error_out: *mut *mut c_char,
) -> *mut PortalPty {
    let result: Result<Box<PortalPty>, String> = (|| {
        let config = read_config(config_ptr, config_len)?;
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: config.rows,
                cols: config.cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| format!("openpty failed: {error}"))?;

        let mut command = CommandBuilder::new(config.file);
        command.args(config.args);
        command.cwd(config.cwd);
        command.env_clear();
        for (key, value) in config.env {
            command.env(key, value);
        }

        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| format!("spawn failed: {error}"))?;
        let pid = child.process_id().unwrap_or(0);
        let killer = child.clone_killer();
        drop(pair.slave);

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| format!("clone reader failed: {error}"))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|error| format!("take writer failed: {error}"))?;

        let (output_tx, output_rx) = channel::<Vec<u8>>();
        thread::spawn(move || {
            let mut buffer = [0u8; 8192];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(count) => {
                        if output_tx.send(buffer[..count].to_vec()).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        let (exit_tx, exit_rx) = channel::<ExitMessage>();
        thread::spawn(move || {
            let status = child.wait();
            let code = status.map(|value| value.exit_code() as i32).unwrap_or(1);
            let _ = exit_tx.send(ExitMessage { code });
        });

        Ok(Box::new(PortalPty {
            writer: Mutex::new(Some(writer)),
            killer: Mutex::new(Some(killer)),
            output_rx: Mutex::new(output_rx),
            exit_rx: Mutex::new(exit_rx),
            exit_status: Mutex::new(None),
            exit_reported: Mutex::new(false),
            pid,
            master: pair.master,
        }))
    })();

    match result {
        Ok(pty) => Box::into_raw(pty),
        Err(error) => {
            set_error(error_out, error);
            ptr::null_mut()
        }
    }
}

#[no_mangle]
pub extern "C" fn weave_pty_pid(pty: *mut PortalPty) -> u32 {
    if pty.is_null() {
        return 0;
    }
    unsafe { (*pty).pid }
}

#[no_mangle]
pub extern "C" fn weave_pty_read(
    pty: *mut PortalPty,
    data_out: *mut *mut u8,
    len_out: *mut usize,
    exit_code_out: *mut i32,
    error_out: *mut *mut c_char,
) -> i32 {
    if pty.is_null() {
        set_error(error_out, "PTY pointer is null");
        return READ_ERROR;
    }

    let pty = unsafe { &*pty };
    if !data_out.is_null() {
        unsafe {
            *data_out = ptr::null_mut();
        }
    }
    if !len_out.is_null() {
        unsafe {
            *len_out = 0;
        }
    }

    let output_result = pty
        .output_rx
        .lock()
        .map_err(|_| "PTY output lock poisoned")
        .and_then(|rx| {
            rx.try_recv().map_err(|error| match error {
                TryRecvError::Empty => "empty",
                TryRecvError::Disconnected => "disconnected",
            })
        });

    match output_result {
        Ok(data) => {
            write_data(data_out, len_out, data);
            return READ_DATA;
        }
        Err("empty") | Err("disconnected") => {}
        Err(error) => {
            set_error(error_out, error);
            return READ_ERROR;
        }
    }

    {
        let mut exit_status = match pty.exit_status.lock() {
            Ok(lock) => lock,
            Err(_) => {
                set_error(error_out, "PTY exit lock poisoned");
                return READ_ERROR;
            }
        };

        if exit_status.is_none() {
            if let Ok(exit) = pty
                .exit_rx
                .lock()
                .map_err(|_| ())
                .and_then(|rx| rx.try_recv().map_err(|_| ()))
            {
                *exit_status = Some(exit);
            }
        }
    }

    let exit_status = match pty.exit_status.lock() {
        Ok(lock) => lock,
        Err(_) => {
            set_error(error_out, "PTY exit lock poisoned");
            return READ_ERROR;
        }
    };

    if let Some(exit) = exit_status.as_ref() {
        let mut reported = match pty.exit_reported.lock() {
            Ok(lock) => lock,
            Err(_) => {
                set_error(error_out, "PTY exit report lock poisoned");
                return READ_ERROR;
            }
        };
        if !*reported {
            *reported = true;
            if !exit_code_out.is_null() {
                unsafe {
                    *exit_code_out = exit.code;
                }
            }
            return READ_EXIT;
        }
    }

    READ_NONE
}

#[no_mangle]
pub extern "C" fn weave_pty_write(
    pty: *mut PortalPty,
    data_ptr: *const u8,
    data_len: usize,
    error_out: *mut *mut c_char,
) -> i32 {
    if pty.is_null() {
        set_error(error_out, "PTY pointer is null");
        return -1;
    }
    if data_ptr.is_null() && data_len > 0 {
        set_error(error_out, "input pointer is null");
        return -1;
    }
    if data_len == 0 {
        return 0;
    }

    let bytes = unsafe { slice::from_raw_parts(data_ptr, data_len) };
    let pty = unsafe { &*pty };
    let mut writer = match pty.writer.lock() {
        Ok(lock) => lock,
        Err(_) => {
            set_error(error_out, "PTY writer lock poisoned");
            return -1;
        }
    };

    match writer.as_mut() {
        Some(writer) => writer.write_all(bytes).map(|_| 0).unwrap_or_else(|error| {
            set_error(error_out, format!("write failed: {error}"));
            -1
        }),
        None => {
            set_error(error_out, "PTY writer is closed");
            -1
        }
    }
}

#[no_mangle]
pub extern "C" fn weave_pty_resize(
    pty: *mut PortalPty,
    cols: u16,
    rows: u16,
    error_out: *mut *mut c_char,
) -> i32 {
    if pty.is_null() {
        set_error(error_out, "PTY pointer is null");
        return -1;
    }

    let pty = unsafe { &*pty };
    pty.master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map(|_| 0)
        .unwrap_or_else(|error| {
            set_error(error_out, format!("resize failed: {error}"));
            -1
        })
}

#[no_mangle]
pub extern "C" fn weave_pty_close(pty: *mut PortalPty) {
    if pty.is_null() {
        return;
    }

    let pty = unsafe { &*pty };
    if let Ok(mut writer) = pty.writer.lock() {
        writer.take();
    }
    if let Ok(mut killer) = pty.killer.lock() {
        if let Some(killer) = killer.as_mut() {
            let _ = killer.kill();
        }
        killer.take();
    }
}

#[no_mangle]
pub extern "C" fn weave_pty_dispose(pty: *mut PortalPty) {
    if pty.is_null() {
        return;
    }
    weave_pty_close(pty);
    unsafe {
        drop(Box::from_raw(pty));
    }
}

#[no_mangle]
pub extern "C" fn weave_pty_free_data(ptr: *mut u8, len: usize) {
    if ptr.is_null() {
        return;
    }
    unsafe {
        drop(Box::from_raw(ptr::slice_from_raw_parts_mut(ptr, len)));
    }
}

#[no_mangle]
pub extern "C" fn weave_pty_free_string(ptr: *mut c_char) {
    if ptr.is_null() {
        return;
    }
    unsafe {
        drop(CString::from_raw(ptr));
    }
}
