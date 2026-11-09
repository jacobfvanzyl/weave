//! Asking the person a yes-or-no question at the terminal, as `weave dispatcher connect` does
//! before having this computer's Host join, and `weave projects add` before adding a clone to a
//! Project.

use std::io::BufRead as _;
use std::io::IsTerminal as _;
use std::io::Write as _;

/// Whether there's a person at a terminal to ask.
pub(crate) fn can() -> bool {
    std::io::stdin().is_terminal()
}

/// Ask `question` at the terminal: yes unless the answer is no.
pub(crate) fn ask(question: &str) -> anyhow::Result<bool> {
    let mut stderr = std::io::stderr();
    write!(stderr, "{question}")?;
    stderr.flush()?;
    let mut answer = String::new();
    if std::io::stdin().lock().read_line(&mut answer)? == 0 {
        return Ok(false);
    }
    let answer = answer.trim().to_ascii_lowercase();
    Ok(!matches!(answer.as_str(), "n" | "no"))
}
