//! Terminal input on its own thread, read in short polling slices and handed to the event
//! loop over a channel.

use std::io;
use std::thread;
use std::time::Duration;

use crossterm::event;
use crossterm::event::Event;
use tokio::sync::mpsc;

/// How long one poll waits before checking whether the loop has gone.
const POLL_SLICE: Duration = Duration::from_millis(50);

pub struct Input {
    events: mpsc::UnboundedReceiver<io::Result<Event>>,
}

impl Input {
    pub fn start() -> Self {
        let (events_tx, events) = mpsc::unbounded_channel();
        thread::spawn(move || read_loop(&events_tx));
        Self { events }
    }

    /// The next event; `None` once the reader has stopped.
    pub async fn next(&mut self) -> Option<io::Result<Event>> {
        self.events.recv().await
    }
}

fn read_loop(events: &mpsc::UnboundedSender<io::Result<Event>>) {
    loop {
        if events.is_closed() {
            return;
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
