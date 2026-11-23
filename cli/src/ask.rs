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

/// Ask for something that mustn't show as it's typed, such as a passphrase: at a terminal,
/// with nothing echoed; otherwise one line of standard input, so a script can pipe it in.
/// None when the person gives up with Ctrl-C or Ctrl-D.
pub(crate) fn secret(prompt: &str) -> anyhow::Result<Option<zeroize::Zeroizing<String>>> {
    use crossterm::event::Event;
    use crossterm::event::KeyCode;
    use crossterm::event::KeyEventKind;
    use crossterm::event::KeyModifiers;

    let mut typed = zeroize::Zeroizing::new(String::new());
    if !can() {
        std::io::stdin().lock().read_line(&mut typed)?;
        let line = typed.trim_end_matches(['\n', '\r']).len();
        typed.truncate(line);
        return Ok(Some(typed));
    }
    let mut stderr = std::io::stderr();
    write!(stderr, "{prompt}")?;
    stderr.flush()?;
    crossterm::terminal::enable_raw_mode()?;
    let read = (|| -> anyhow::Result<bool> {
        loop {
            let Event::Key(key) = crossterm::event::read()? else {
                continue;
            };
            if key.kind == KeyEventKind::Release {
                continue;
            }
            let control = key.modifiers.contains(KeyModifiers::CONTROL);
            match key.code {
                KeyCode::Enter => return Ok(true),
                KeyCode::Char('c' | 'd') if control => return Ok(false),
                KeyCode::Esc => return Ok(false),
                KeyCode::Backspace => {
                    typed.pop();
                }
                KeyCode::Char(c) if !control => typed.push(c),
                _ => {}
            }
        }
    })();
    crossterm::terminal::disable_raw_mode()?;
    writeln!(stderr)?;
    Ok(read?.then_some(typed))
}
