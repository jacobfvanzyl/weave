//! `weave pair` and `weave devices`: the person's devices and other computers paired with the
//! Dispatcher (WVE-176), on the Dispatcher's computer: pairing one, listing them, and revoking
//! one. Paired devices reach every Host through the Dispatcher (ADR 0030), and Hosts pair with
//! nothing (WVE-197), so these name what the person manages, as WVE-188 has top-level commands do;
//! they were `weave dispatcher pair` and `weave dispatcher devices` before, with no alias left.
//! From a computer paired with a Dispatcher elsewhere they say where it runs.

use std::io::IsTerminal as _;
use std::process::ExitCode;

use anyhow::Context;
use anyhow::bail;
use clap::Args;
use clap::Subcommand;
use serde::Deserialize;
use serde::Serialize;
use weave_dispatcher::DispatcherPaths;
use weave_dispatcher::client::DispatcherConnection;
use weave_host_protocol::devices::Device;
use weave_host_protocol::devices::ListDevicesRequest;
use weave_host_protocol::devices::OfferDeviceRequest;
use weave_host_protocol::devices::RevokeDeviceRequest;

use crate::clock::ago;
use crate::clock::now_ms;
use crate::dispatcher;
use crate::dispatcher::connect_here;
use crate::dispatcher::remote_pairing;
use crate::service;

pub const LOG: &str = "warn";

#[derive(Args)]
pub struct PairArgs {
    /// What the Dispatcher calls the device, instead of the name it gives.
    #[arg(long)]
    name: Option<String>,

    /// Print the URL and code as JSON, and don't wait: for `weave dispatcher connect` on
    /// another computer, which runs this over SSH.
    #[arg(long)]
    json: bool,
}

/// What `weave pair --json` prints: the URL and code a device or another computer pairs with.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Offered {
    pub(crate) url: String,
    pub(crate) code: String,
    pub(crate) expires_at: u64,
}

#[derive(Args)]
pub struct DevicesArgs {
    #[command(subcommand)]
    command: Option<DevicesCommand>,
}

#[derive(Subcommand)]
enum DevicesCommand {
    /// List the devices and computers paired with the Dispatcher (the default).
    List(ListArgs),
    /// Forget a device and close its connections, those to your Hosts too. It has to pair
    /// again.
    Revoke(RevokeArgs),
}

#[derive(Args, Default)]
struct ListArgs {
    /// Print them as JSON.
    #[arg(long)]
    json: bool,
}

#[derive(Args)]
struct RevokeArgs {
    /// The device's id, as `weave devices` lists it.
    device_id: String,
}

/// The Dispatcher on this computer, for what only its own computer may ask: pairing and
/// revoking devices.
async fn here(paths: &DispatcherPaths) -> anyhow::Result<DispatcherConnection> {
    match connect_here(paths).await {
        Ok(connection) => Ok(connection),
        Err(error) => match remote_pairing()? {
            Some(paired) => bail!(
                "the Dispatcher runs on {}, and its devices are managed there: run this on that \
                 computer",
                paired.place()
            ),
            None => Err(error),
        },
    }
}

/// `weave pair`: show a code a device or another computer pairs with the Dispatcher with, and
/// wait for it. The offer turns the Dispatcher's WebSocket on, Tailscale Serve entry and all.
pub async fn pair(args: PairArgs) -> anyhow::Result<ExitCode> {
    let paths = dispatcher::paths()?;
    let mut dispatcher = here(&paths).await?;
    let result = offer(&mut dispatcher, &paths, args).await;
    dispatcher.shutdown().await;
    result.map(|()| ExitCode::SUCCESS)
}

async fn offer(
    dispatcher: &mut DispatcherConnection,
    paths: &DispatcherPaths,
    args: PairArgs,
) -> anyhow::Result<()> {
    let offer = dispatcher
        .send(OfferDeviceRequest { name: args.name })
        .await
        .map_err(|error| anyhow::anyhow!("{}", error.message))?;
    let Some(url) = offer.url else {
        bail!("the Dispatcher gave no URL to pair with");
    };
    if args.json {
        let offered = Offered {
            url,
            code: offer.code,
            expires_at: offer.expires_at,
        };
        println!("{}", serde_json::to_string_pretty(&offered)?);
        return Ok(());
    }
    println!("{}\n", qr_code(&pairing_link(&url, &offer.code))?);
    println!(
        "Scan this with the device, or on a computer to pair, run:\n  weave dispatcher connect \
         {url} {}\n\nThe code works once, for five minutes.",
        offer.code
    );
    if !service::dispatcher_installed(paths) {
        eprintln!(
            "\nThe Dispatcher isn't installed as a service, so after this computer restarts your \
             devices can't reach it, or your Hosts through it, until something here starts it. \
             `weave dispatcher install` keeps it running."
        );
    }
    let expires_in = offer.expires_at.saturating_sub(now_ms());
    let paired = tokio::select! {
        paired = dispatcher.paired() => paired,
        () = tokio::time::sleep(std::time::Duration::from_millis(expires_in)) => {
            println!("\nNothing paired, and the code has expired.");
            return Ok(());
        }
        _ = tokio::signal::ctrl_c() => {
            println!("\nStopped waiting; the code stays good until it expires.");
            return Ok(());
        }
    };
    let device = paired.context("the Dispatcher went away")?;
    println!(
        "\nPaired {} ({}), as code {}.",
        device.name,
        device.id,
        grouped(&offer.code)
    );
    Ok(())
}

/// The link the QR code holds, which the app opens.
fn pairing_link(url: &str, code: &str) -> String {
    link("weave://pair-dispatcher?", url, code)
}

/// `prefix`, such as `weave://pair-dispatcher?`, with `url` and `code`.
pub(crate) fn link(prefix: &str, url: &str, code: &str) -> String {
    format!("{prefix}url={}&code={code}", percent_encode(url))
}

fn percent_encode(text: &str) -> String {
    text.bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                char::from(byte).to_string()
            }
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

/// A code in groups of five, which pairing reads without the dashes.
pub(crate) fn grouped(code: &str) -> String {
    code.as_bytes()
        .chunks(5)
        .map(|chunk| String::from_utf8_lossy(chunk).into_owned())
        .collect::<Vec<_>>()
        .join("-")
}

/// `text` as a QR code in the terminal, black on white whatever its colors, so a camera
/// reads it.
pub(crate) fn qr_code(text: &str) -> anyhow::Result<String> {
    use qrcode::render::unicode::Dense1x2;
    let code = qrcode::QrCode::new(text.as_bytes()).context("making the QR code")?;
    let rendered = code
        .render::<Dense1x2>()
        .dark_color(Dense1x2::Dark)
        .light_color(Dense1x2::Light)
        .quiet_zone(true)
        .build();
    if !std::io::stdout().is_terminal() {
        return Ok(rendered);
    }
    Ok(rendered
        .lines()
        .map(|line| format!("\x1b[30;47m{line}\x1b[0m"))
        .collect::<Vec<_>>()
        .join("\n"))
}

/// `weave devices`: list or revoke the devices paired with the Dispatcher.
pub async fn command(args: DevicesArgs) -> anyhow::Result<ExitCode> {
    let paths = dispatcher::paths()?;
    let command = args
        .command
        .unwrap_or_else(|| DevicesCommand::List(ListArgs::default()));
    let dispatcher = here(&paths).await?;
    let result = match command {
        DevicesCommand::List(ListArgs { json }) => {
            match dispatcher.send(ListDevicesRequest {}).await {
                Ok(listed) if json => serde_json::to_string_pretty(&listed.devices)
                    .map(|text| println!("{text}"))
                    .map_err(anyhow::Error::from),
                Ok(listed) => {
                    print!("{}", describe(&listed.devices, now_ms()));
                    Ok(())
                }
                Err(error) => Err(anyhow::anyhow!("{}", error.message)),
            }
        }
        DevicesCommand::Revoke(RevokeArgs { device_id }) => dispatcher
            .send(RevokeDeviceRequest {
                device_id: device_id.clone(),
            })
            .await
            .map(|_| println!("Revoked {device_id}; it has to pair again."))
            .map_err(|error| anyhow::anyhow!("{}", error.message)),
    };
    dispatcher.shutdown().await;
    result.map(|()| ExitCode::SUCCESS)
}

fn describe(devices: &[Device], now_ms: u64) -> String {
    if devices.is_empty() {
        return "No device is paired with the Dispatcher. `weave pair` pairs one, and `weave \
                dispatcher connect <this computer>` on another computer pairs that.\n"
            .to_owned();
    }
    listing(devices, now_ms)
}

/// Each device, with when it was paired and last seen.
fn listing(devices: &[Device], now_ms: u64) -> String {
    let width = devices
        .iter()
        .map(|device| device.name.chars().count())
        .max()
        .unwrap_or(0);
    devices
        .iter()
        .map(|device| {
            let seen = match (device.connections, device.last_seen_at) {
                (0, Some(seen)) => format!("seen {} ago", ago(now_ms, seen)),
                (0, None) => "not seen since pairing".to_owned(),
                (1, _) => "connected".to_owned(),
                (connections, _) => format!("connected {connections} times"),
            };
            let kind = if device.service { ", a service" } else { "" };
            format!(
                "{}  {:width$}  paired {} ago{kind}, {seen}\n",
                device.id,
                device.name,
                ago(now_ms, device.paired_at)
            )
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::*;

    #[test]
    fn the_link_is_the_dispatchers_and_carries_the_url_encoded() {
        assert_eq!(
            pairing_link("wss://homelab.example.ts.net:7342", "ABC"),
            "weave://pair-dispatcher?url=wss%3A%2F%2Fhomelab.example.ts.net%3A7342&code=ABC"
        );
        assert_eq!(grouped("ABCDEFGHIJKL"), "ABCDE-FGHIJ-KL");
        assert!(qr_code("weave://pair-dispatcher").is_ok());
    }

    #[test]
    fn devices_are_listed_with_when_they_were_seen() {
        let device = |id: &str, connections, last_seen_at| Device {
            id: id.to_owned(),
            name: "iPad".to_owned(),
            paired_at: 0,
            last_seen_at,
            connections,
            service: false,
        };
        let day = 86_400_000;
        assert_eq!(
            describe(
                &[device("d-1", 1, Some(day)), device("d-2", 0, Some(day))],
                2 * day
            ),
            "d-1  iPad  paired 2d ago, connected\nd-2  iPad  paired 2d ago, seen 1d ago\n"
        );
        assert!(describe(&[], 0).starts_with("No device is paired"));
    }
}
