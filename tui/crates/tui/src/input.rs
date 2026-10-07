//! Terminal input on its own thread, which can stand aside while another program (the
//! user's editor) has the terminal.
//!
//! crossterm's `EventStream` keeps reading stdin in the background, so it would take the
//! editor's keystrokes. This reader polls in short slices instead and, when paused, stops
//! between them and says so before the editor starts.

use std::io;
use std::sync::mpsc as std_mpsc;
use std::thread;
use std::time::Duration;

use crossterm::event;
use crossterm::event::Event;
use tokio::sync::mpsc;

/// How long one poll waits; pausing takes at most this long.
const POLL_SLICE: Duration = Duration::from_millis(50);

enum Control {
    /// Stop reading until resumed; answer once stopped.
    Pause(std_mpsc::Sender<()>),
    Resume,
}

pub struct Input {
    events: mpsc::UnboundedReceiver<io::Result<Event>>,
    control: std_mpsc::Sender<Control>,
}

impl Input {
    pub fn start() -> Self {
        let (events_tx, events) = mpsc::unbounded_channel();
        let (control, control_rx) = std_mpsc::channel();
        thread::spawn(move || read_loop(&events_tx, &control_rx));
        Self { events, control }
    }

    /// The next event; `None` once the reader has stopped.
    pub async fn next(&mut self) -> Option<io::Result<Event>> {
        self.events.recv().await
    }

    /// Stop reading the terminal, returning once the reader no longer touches it.
    pub fn pause(&self) {
        let (stopped, wait) = std_mpsc::channel();
        if self.control.send(Control::Pause(stopped)).is_ok() {
            let _ = wait.recv_timeout(POLL_SLICE * 10);
        }
    }

    pub fn resume(&self) {
        let _ = self.control.send(Control::Resume);
    }
}

fn read_loop(
    events: &mpsc::UnboundedSender<io::Result<Event>>,
    control: &std_mpsc::Receiver<Control>,
) {
    loop {
        match control.try_recv() {
            Ok(Control::Pause(stopped)) => {
                let _ = stopped.send(());
                // Wait for the resume, ignoring repeated pauses.
                loop {
                    match control.recv() {
                        Ok(Control::Resume) => break,
                        Ok(Control::Pause(stopped)) => {
                            let _ = stopped.send(());
                        }
                        Err(_) => return,
                    }
                }
            }
            Ok(Control::Resume) => {}
            Err(std_mpsc::TryRecvError::Disconnected) => return,
            Err(std_mpsc::TryRecvError::Empty) => {}
        }
        match event::poll(POLL_SLICE) {
            Ok(true) => {
                if events.send(event::read()).is_err() {
                    return;
                }
            }
            Ok(false) => {}
            Err(error) => {
                let _ = events.send(Err(error));
                return;
            }
        }
    }
}
