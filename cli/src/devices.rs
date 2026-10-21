//! `weave pair` and `weave devices`: pairing the person's other devices with the weave Host,
//! listing them, and revoking them. Paired devices' remote clients reach the Host through
//! Tailscale Serve, whose entry the Host makes when pairing turns remote access on
//! (`docs/specs/wve-90-remote-clients.md`, ADR 0016).

use std::io::IsTerminal as _;

use anyhow::Context;
use anyhow::bail;
use clap::Args;
use clap::Subcommand;
use weave_host_client::HostConnection;
use weave_host_client::HostEvent;
use weave_host_protocol::devices::Device;
use weave_host_protocol::devices::ListDevicesRequest;
use weave_host_protocol::devices::OfferDeviceRequest;
use weave_host_protocol::devices::RevokeDeviceRequest;
use weave_host_protocol::errors;
use weave_host_protocol::host::Service;
use weave_host_protocol::host::StatusRequest;

use crate::daemon;
use crate::daemon::ago;
use crate::daemon::now_ms;

#[derive(Args)]
pub struct PairArgs {
    /// The name the device gets, instead of the one it gives.
    #[arg(long)]
    name: Option<String>,
}

#[derive(Args)]
pub struct DevicesArgs {
    #[command(subcommand)]
    command: Option<DevicesCommand>,
}

#[derive(Subcommand)]
enum DevicesCommand {
    /// List the paired devices (the default).
    List(ListArgs),
    /// Forget a device and close its connections. It has to pair again.
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
    device_id: String,
}

/// `weave pair`: show a code a device pairs with, and wait for it. The offer turns the
/// Host's remote access on, Tailscale Serve entry and all (ADR 0016).
pub async fn pair(args: PairArgs) -> anyhow::Result<()> {
    let paths = daemon::paths()?;
    let transport = daemon::open(&paths).await?;
    let (connection, mut events) = HostConnection::connect(
        transport,
        daemon::client_info("weave-cli"),
        daemon::capabilities("weave-cli"),
    )
    .await?;
    let result = offer(&connection, &mut events, args.name).await;
    connection.shutdown().await;
    result
}

async fn offer(
    connection: &HostConnection,
    events: &mut tokio::sync::mpsc::UnboundedReceiver<HostEvent>,
    name: Option<String>,
) -> anyhow::Result<()> {
    let status = connection.send(StatusRequest {}).await?;
    let offer = match connection.send(OfferDeviceRequest { name }).await {
        Ok(offer) => offer,
        Err(error) if errors::is(&error, errors::REMOTE_UNAVAILABLE) => bail!("{}", error.message),
        Err(error) => return Err(error.into()),
    };
    let Some(url) = offer.url else {
        bail!(
            "the running weave Host is older than this weave and can't turn remote access on; \
             restart it with `weave daemon restart`"
        );
    };
    let url = url.as_str();
    println!("{}\n", qr_code(&pairing_link(url, &offer.code))?);
    println!(
        "Scan this with the device, or enter:\n  Host  {url}\n  Code  {}\n\nThe code works \
         once, for five minutes.",
        grouped(&offer.code)
    );
    if status.service != Service::Launchd {
        eprintln!(
            "\nThe Host isn't installed as a service, so after this computer restarts your \
             devices can't reach it until something here starts it. `weave daemon install` \
             keeps it running."
        );
    }
    let expires_in = offer.expires_at.saturating_sub(now_ms());
    let paired = tokio::select! {
        paired = paired(events) => paired,
        () = tokio::time::sleep(std::time::Duration::from_millis(expires_in)) => {
            println!("\nNo device paired, and the code has expired.");
            return Ok(());
        }
        _ = tokio::signal::ctrl_c() => {
            println!("\nStopped waiting; the code stays good until it expires.");
            return Ok(());
        }
    };
    let device = paired.context("the weave Host went away")?;
    println!("\nPaired {} ({}).", device.name, device.id);
    Ok(())
}

/// The device that takes this connection's offer.
async fn paired(events: &mut tokio::sync::mpsc::UnboundedReceiver<HostEvent>) -> Option<Device> {
    while let Some(event) = events.recv().await {
        match event {
            HostEvent::DevicePaired(notification) => return Some(notification.device),
            HostEvent::Disconnected(_) => return None,
            _ => {}
        }
    }
    None
}

/// The link the QR code holds, which the mobile client opens.
fn pairing_link(url: &str, code: &str) -> String {
    format!("weave://pair?url={}&code={code}", percent_encode(url))
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
fn grouped(code: &str) -> String {
    code.as_bytes()
        .chunks(5)
        .map(|chunk| String::from_utf8_lossy(chunk).into_owned())
        .collect::<Vec<_>>()
        .join("-")
}

/// `text` as a QR code in the terminal, black on white whatever its colors, so a camera
/// reads it.
fn qr_code(text: &str) -> anyhow::Result<String> {
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

/// `weave devices`: list or revoke paired devices.
pub async fn devices(args: DevicesArgs) -> anyhow::Result<()> {
    let paths = daemon::paths()?;
    let command = args
        .command
        .unwrap_or_else(|| DevicesCommand::List(ListArgs::default()));
    let transport = daemon::open(&paths).await?;
    let (connection, _events) = HostConnection::connect(
        transport,
        daemon::client_info("weave-cli"),
        daemon::capabilities("weave-cli"),
    )
    .await?;
    let result = match command {
        DevicesCommand::List(ListArgs { json }) => {
            let devices = connection
                .send(ListDevicesRequest {})
                .await
                .map(|list| list.devices);
            devices.map_err(anyhow::Error::from).and_then(|devices| {
                if json {
                    println!("{}", serde_json::to_string_pretty(&devices)?);
                } else {
                    print!("{}", describe(&devices, now_ms()));
                }
                Ok(())
            })
        }
        DevicesCommand::Revoke(RevokeArgs { device_id }) => connection
            .send(RevokeDeviceRequest {
                device_id: device_id.clone(),
            })
            .await
            .map(|_| println!("Revoked {device_id}; it has to pair again."))
            .map_err(anyhow::Error::from),
    };
    connection.shutdown().await;
    result
}

fn describe(devices: &[Device], now_ms: u64) -> String {
    if devices.is_empty() {
        return "No devices are paired; `weave pair` pairs one.\n".to_owned();
    }
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
            format!(
                "{}  {:width$}  paired {} ago, {seen}\n",
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
    fn the_link_carries_the_url_encoded() {
        assert_eq!(
            pairing_link("wss://mac.example.ts.net:7341", "ABC"),
            "weave://pair?url=wss%3A%2F%2Fmac.example.ts.net%3A7341&code=ABC"
        );
        assert_eq!(grouped("ABCDEFGHIJKL"), "ABCDE-FGHIJ-KL");
        assert!(qr_code("weave://pair").is_ok());
    }

    #[test]
    fn devices_are_listed_with_when_they_were_seen() {
        let device = |id: &str, connections, last_seen_at| Device {
            id: id.to_owned(),
            name: "iPad".to_owned(),
            paired_at: 0,
            last_seen_at,
            connections,
        };
        let day = 86_400_000;
        assert_eq!(
            describe(
                &[device("d-1", 1, Some(day)), device("d-2", 0, Some(day))],
                2 * day
            ),
            "d-1  iPad  paired 2d ago, connected\nd-2  iPad  paired 2d ago, seen 1d ago\n"
        );
        assert!(describe(&[], 0).starts_with("No devices"));
    }
}
