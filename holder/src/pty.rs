//! The terminal's PTY and the program on it: started with `forkpty`, read, written, resized,
//! hung up and waited for, and the processes behind it named.

use std::ffi::CString;
use std::io;
use std::os::fd::AsRawFd;
use std::os::fd::FromRawFd;
use std::os::fd::OwnedFd;
use std::os::fd::RawFd;
use std::os::unix::ffi::OsStrExt;
use std::path::Path;

use crate::event::Size;
use crate::launch::Launch;

/// The PTY's master side and the program running on its other side, in a session of its own.
pub struct Pty {
    master: OwnedFd,
    child: libc::pid_t,
}

impl Pty {
    /// Starts `launch` on a new PTY of `size`, in `cwd`.
    pub fn spawn(launch: &Launch, cwd: &Path, size: Size) -> io::Result<Self> {
        // Everything the child needs is made before fork, which leaves it only exec to do.
        let program = cstring(
            launch
                .argv
                .first()
                .map(String::as_bytes)
                .unwrap_or_default(),
        )?;
        let argv = launch
            .argv
            .iter()
            .map(|arg| cstring(arg.as_bytes()))
            .collect::<io::Result<Vec<_>>>()?;
        let envp = launch
            .env
            .iter()
            .map(|(key, value)| cstring(format!("{key}={value}").as_bytes()))
            .collect::<io::Result<Vec<_>>>()?;
        let cwd = cstring(cwd.as_os_str().as_bytes())?;
        let mut argv_ptrs: Vec<*const libc::c_char> = argv.iter().map(|arg| arg.as_ptr()).collect();
        argv_ptrs.push(std::ptr::null());
        let mut envp_ptrs: Vec<*const libc::c_char> = envp.iter().map(|var| var.as_ptr()).collect();
        envp_ptrs.push(std::ptr::null());
        let mut winsize = winsize(size);

        let mut master: libc::c_int = -1;
        // SAFETY: the child calls only async-signal-safe functions before exec.
        let pid = unsafe {
            libc::forkpty(
                &mut master,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                // macOS's takes it mutable, Linux's const.
                &raw mut winsize,
            )
        };
        if pid < 0 {
            return Err(io::Error::last_os_error());
        }
        if pid == 0 {
            unsafe {
                // Rust ignores SIGPIPE, and an ignored signal stays ignored across exec.
                for signal in [
                    libc::SIGPIPE,
                    libc::SIGINT,
                    libc::SIGQUIT,
                    libc::SIGTERM,
                    libc::SIGHUP,
                ] {
                    libc::signal(signal, libc::SIG_DFL);
                }
                let mut none: libc::sigset_t = std::mem::zeroed();
                libc::sigemptyset(&mut none);
                libc::sigprocmask(libc::SIG_SETMASK, &none, std::ptr::null_mut());
                libc::chdir(cwd.as_ptr());
                libc::execve(program.as_ptr(), argv_ptrs.as_ptr(), envp_ptrs.as_ptr());
                libc::_exit(127);
            }
        }
        // SAFETY: forkpty gave the master to this process alone.
        let master = unsafe { OwnedFd::from_raw_fd(master) };
        set_cloexec(master.as_raw_fd())?;
        Ok(Self { master, child: pid })
    }

    /// The program's process id, which leads its session and process group.
    pub fn child(&self) -> libc::pid_t {
        self.child
    }

    /// Reads output into `buffer`; 0 once nothing holds the other side open any more.
    pub fn read(&self, buffer: &mut [u8]) -> io::Result<usize> {
        loop {
            let read = unsafe {
                libc::read(
                    self.master.as_raw_fd(),
                    buffer.as_mut_ptr().cast(),
                    buffer.len(),
                )
            };
            if read >= 0 {
                return Ok(read as usize);
            }
            let error = io::Error::last_os_error();
            match error.raw_os_error() {
                Some(libc::EINTR) => continue,
                // Linux reports a closed other side as EIO.
                Some(libc::EIO) => return Ok(0),
                _ => return Err(error),
            }
        }
    }

    /// Writes all of `bytes`, as typed.
    pub fn write_all(&self, mut bytes: &[u8]) -> io::Result<()> {
        while !bytes.is_empty() {
            let written =
                unsafe { libc::write(self.master.as_raw_fd(), bytes.as_ptr().cast(), bytes.len()) };
            if written < 0 {
                let error = io::Error::last_os_error();
                if error.raw_os_error() == Some(libc::EINTR) {
                    continue;
                }
                return Err(error);
            }
            bytes = &bytes[written as usize..];
        }
        Ok(())
    }

    /// Gives the PTY a new size, which sends the program SIGWINCH.
    pub fn resize(&self, size: Size) -> io::Result<()> {
        let winsize = winsize(size);
        if unsafe { libc::ioctl(self.master.as_raw_fd(), libc::TIOCSWINSZ, &winsize) } < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    /// The process group in the foreground of the PTY: the shell, or the command it runs.
    pub fn foreground(&self) -> Option<libc::pid_t> {
        let group = unsafe { libc::tcgetpgrp(self.master.as_raw_fd()) };
        (group > 0).then_some(group)
    }

    /// Hangs up the program's session, as closing a terminal window does.
    pub fn hang_up(&self) {
        unsafe { libc::kill(-self.child, libc::SIGHUP) };
    }

    /// Waits for the program to exit, and says how: its exit code, or 128 and the signal.
    pub fn wait(&self) -> io::Result<i32> {
        let mut status = 0;
        loop {
            let waited = unsafe { libc::waitpid(self.child, &mut status, 0) };
            if waited == self.child {
                break;
            }
            let error = io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::EINTR) {
                return Err(error);
            }
        }
        Ok(if libc::WIFEXITED(status) {
            libc::WEXITSTATUS(status)
        } else {
            128 + libc::WTERMSIG(status)
        })
    }
}

/// A process's name, as `ps` shows it.
#[cfg(target_os = "macos")]
pub fn process_name(pid: libc::pid_t) -> String {
    let mut buffer = [0u8; 256];
    let len = unsafe { libc::proc_name(pid, buffer.as_mut_ptr().cast(), buffer.len() as u32) };
    if len <= 0 {
        return String::new();
    }
    String::from_utf8_lossy(&buffer[..len as usize]).into_owned()
}

/// A process's name, as `ps` shows it.
#[cfg(not(target_os = "macos"))]
pub fn process_name(pid: libc::pid_t) -> String {
    std::fs::read_to_string(format!("/proc/{pid}/comm"))
        .map(|name| name.trim().to_string())
        .unwrap_or_default()
}

/// The user id of the process on the other end of a Unix socket.
pub fn peer_uid(fd: RawFd) -> io::Result<libc::uid_t> {
    #[cfg(target_os = "linux")]
    {
        let mut credentials: libc::ucred = unsafe { std::mem::zeroed() };
        let mut len = size_of::<libc::ucred>() as libc::socklen_t;
        let result = unsafe {
            libc::getsockopt(
                fd,
                libc::SOL_SOCKET,
                libc::SO_PEERCRED,
                (&mut credentials as *mut libc::ucred).cast(),
                &mut len,
            )
        };
        if result < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(credentials.uid)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let mut uid: libc::uid_t = 0;
        let mut gid: libc::gid_t = 0;
        if unsafe { libc::getpeereid(fd, &mut uid, &mut gid) } < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(uid)
    }
}

pub fn set_cloexec(fd: RawFd) -> io::Result<()> {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn winsize(size: Size) -> libc::winsize {
    libc::winsize {
        ws_row: size.rows,
        ws_col: size.cols,
        ws_xpixel: 0,
        ws_ypixel: 0,
    }
}

fn cstring(bytes: &[u8]) -> io::Result<CString> {
    CString::new(bytes)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "a NUL in an argument"))
}
