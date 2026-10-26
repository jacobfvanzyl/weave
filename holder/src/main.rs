//! `weave-holder`, which the Host starts to keep one terminal alive (ADR 0022).

use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        ["--version" | "-V"] => match weave_holder::vt::codec() {
            Ok(codec) => {
                println!("weave-holder {} ({codec})", env!("CARGO_PKG_VERSION"));
                ExitCode::SUCCESS
            }
            Err(error) => {
                eprintln!("weave-holder: {error}");
                ExitCode::FAILURE
            }
        },
        _ => {
            eprintln!("usage: weave-holder --version");
            ExitCode::from(2)
        }
    }
}
