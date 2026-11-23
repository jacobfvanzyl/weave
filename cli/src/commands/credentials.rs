//! `weave credentials`: the person's credentials, which the Dispatcher keeps encrypted and
//! reads only while it is unlocked (ADR 0036, WVE-239): what lets their agents and git act as
//! them. Setting the passphrase, unlocking after the Dispatcher starts, locking, and keeping,
//! listing and removing credentials. A value is typed without showing, piped in, or read from a
//! file, never given as an argument, and nothing here prints one back.

use std::path::PathBuf;
use std::process::ExitCode;

use anyhow::Context as _;
use anyhow::bail;
use clap::Args;
use clap::Subcommand;
use clap::ValueEnum;
use weave_dispatcher::credentials::SHORTEST_PASSPHRASE;
use weave_host_protocol::dispatcher::CREDENTIALS_FEATURE;
use weave_host_protocol::dispatcher::Credential;
use weave_host_protocol::dispatcher::CredentialKind;
use weave_host_protocol::dispatcher::CredentialsState;
use weave_host_protocol::dispatcher::CredentialsStatus;
use weave_host_protocol::dispatcher::CredentialsStatusRequest;
use weave_host_protocol::dispatcher::ListCredentialsRequest;
use weave_host_protocol::dispatcher::LockCredentialsRequest;
use weave_host_protocol::dispatcher::RemoveCredentialRequest;
use weave_host_protocol::dispatcher::SetCredentialRequest;
use weave_host_protocol::dispatcher::UnlockCredentialsRequest;
use zeroize::Zeroizing;

use crate::ask;
use crate::clock::ago;
use crate::clock::now_ms;
use crate::dispatcher;
use crate::dispatcher::connect;
use crate::dispatcher::require;

pub const LOG: &str = "warn";

#[derive(Args)]
pub struct CredentialsArgs {
    #[command(subcommand)]
    command: Option<CredentialsCommand>,
}

#[derive(Subcommand)]
enum CredentialsCommand {
    /// The credentials the Dispatcher keeps, without their values, and whether it can read
    /// them (the default).
    List(ListArgs),
    /// Give the Dispatcher the passphrase its credentials are encrypted under, which it holds
    /// in memory until it stops; the first time, set the passphrase.
    Unlock,
    /// Have the Dispatcher forget the passphrase, so it reads no credential until unlocked.
    Lock,
    /// Keep a credential, in place of one of that name. Its value is typed without showing,
    /// piped in, or read from a file.
    Set(SetArgs),
    /// Forget a credential.
    Remove(RemoveArgs),
}

#[derive(Args, Default)]
struct ListArgs {
    /// Print them as JSON.
    #[arg(long)]
    json: bool,
}

#[derive(Clone, Copy, ValueEnum)]
enum Kind {
    /// A value that doesn't change until you replace it, such as a git token.
    Token,
    /// What a vendor's own program wrote when you signed in to it.
    SignIn,
}

#[derive(Args)]
struct SetArgs {
    /// What the credential is called.
    name: String,
    #[arg(long, value_enum, default_value = "token")]
    kind: Kind,
    /// Read the value from this file, such as a vendor's sign-in file.
    #[arg(long)]
    file: Option<PathBuf>,
    /// The agent a sign-in is for, by its id; the credential's name without one.
    #[arg(long)]
    agent: Option<String>,
}

#[derive(Args)]
struct RemoveArgs {
    name: String,
}

pub async fn command(args: CredentialsArgs) -> anyhow::Result<ExitCode> {
    let dispatcher = connect(&dispatcher::paths()?).await?;
    let done = async {
        require(&dispatcher, CREDENTIALS_FEATURE, "credentials")?;
        match args
            .command
            .unwrap_or_else(|| CredentialsCommand::List(ListArgs::default()))
        {
            CredentialsCommand::List(ListArgs { json }) => {
                let status = dispatcher.send(CredentialsStatusRequest {}).await;
                let status = status.map_err(said)?;
                let listed = dispatcher.send(ListCredentialsRequest {}).await;
                let credentials = listed.map_err(said)?.credentials;
                if json {
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&serde_json::json!({
                            "state": status.state,
                            "credentials": credentials,
                        }))?
                    );
                } else {
                    print!("{}", describe(&status, &credentials, now_ms()));
                }
            }
            CredentialsCommand::Unlock => {
                let status = dispatcher.send(CredentialsStatusRequest {}).await;
                let create = match status.map_err(said)?.state {
                    CredentialsState::Unlocked => {
                        println!("The credentials are unlocked already.");
                        return Ok(());
                    }
                    CredentialsState::Unset => true,
                    CredentialsState::Locked => false,
                };
                let Some(passphrase) = passphrase(create)? else {
                    bail!("no passphrase given");
                };
                let unlocked = dispatcher
                    .send(UnlockCredentialsRequest {
                        passphrase: passphrase.to_string(),
                        create,
                    })
                    .await;
                let status = unlocked.map_err(said)?;
                println!(
                    "{} The Dispatcher reads its {} until it stops or `weave credentials lock`.",
                    if create {
                        "The passphrase is set."
                    } else {
                        "Unlocked."
                    },
                    counted(status.count)
                );
            }
            CredentialsCommand::Lock => {
                let locked = dispatcher.send(LockCredentialsRequest {}).await;
                locked.map_err(said)?;
                println!("Locked: the Dispatcher reads no credential until it's unlocked.");
            }
            CredentialsCommand::Set(SetArgs {
                name,
                kind,
                file,
                agent,
            }) => {
                let agent = match kind {
                    Kind::SignIn => Some(agent.unwrap_or_else(|| name.clone())),
                    Kind::Token => agent,
                };
                let value = match file {
                    Some(file) => Zeroizing::new(
                        std::fs::read_to_string(&file)
                            .with_context(|| format!("reading {}", file.display()))?,
                    ),
                    None => match ask::secret(&format!("Value for {name}: "))? {
                        Some(value) => value,
                        None => bail!("no value given"),
                    },
                };
                if value.is_empty() {
                    bail!("no value given");
                }
                let kept = dispatcher
                    .send(SetCredentialRequest {
                        name,
                        kind: match kind {
                            Kind::Token => CredentialKind::Token,
                            Kind::SignIn => CredentialKind::SignIn,
                        },
                        value: value.to_string(),
                        agent,
                    })
                    .await;
                let credential = kept.map_err(said)?.credential;
                println!(
                    "Kept {}, {}. Your Hosts are given it now.",
                    credential.name,
                    kind_of(&credential)
                );
            }
            CredentialsCommand::Remove(RemoveArgs { name }) => {
                let removed = dispatcher
                    .send(RemoveCredentialRequest { name: name.clone() })
                    .await;
                removed.map_err(said)?;
                println!("Removed {name}.");
            }
        }
        Ok(())
    }
    .await;
    dispatcher.shutdown().await;
    done.map(|()| ExitCode::SUCCESS)
}

/// The Dispatcher's refusal, in its own words.
fn said(error: agent_client_protocol::Error) -> anyhow::Error {
    anyhow::anyhow!("{}", error.message)
}

/// The passphrase, typed without showing; a new one twice.
fn passphrase(create: bool) -> anyhow::Result<Option<Zeroizing<String>>> {
    if !create {
        return ask::secret("Passphrase: ");
    }
    if ask::can() {
        eprintln!(
            "The Dispatcher keeps no credentials yet. Choose a passphrase of at least \
             {SHORTEST_PASSPHRASE} characters. It is asked for each time the Dispatcher starts, \
             and nothing can recover it."
        );
    }
    let Some(first) = ask::secret("New passphrase: ")? else {
        return Ok(None);
    };
    // Piped in, it is given once.
    if ask::can() {
        let Some(again) = ask::secret("Again: ")? else {
            return Ok(None);
        };
        if *first != *again {
            bail!("the two didn't match");
        }
    }
    Ok(Some(first))
}

fn kind_word(kind: CredentialKind) -> &'static str {
    match kind {
        CredentialKind::Token => "a token",
        CredentialKind::SignIn => "a sign-in",
    }
}

/// A credential's kind, and the agent a sign-in is for.
fn kind_of(credential: &Credential) -> String {
    match &credential.agent {
        Some(agent) => format!("{} for {agent}", kind_word(credential.kind)),
        None => kind_word(credential.kind).to_owned(),
    }
}

fn counted(count: u32) -> String {
    match count {
        1 => "1 credential".to_owned(),
        count => format!("{count} credentials"),
    }
}

fn describe(status: &CredentialsStatus, credentials: &[Credential], now_ms: u64) -> String {
    let mut said = match status.state {
        CredentialsState::Unset => {
            "The Dispatcher keeps no credentials yet; `weave credentials unlock` sets the \
             passphrase they're encrypted under.\n"
                .to_owned()
        }
        CredentialsState::Locked => {
            "Locked: `weave credentials unlock` lets the Dispatcher read them.\n".to_owned()
        }
        CredentialsState::Unlocked => "Unlocked.\n".to_owned(),
    };
    if credentials.is_empty() && status.state != CredentialsState::Unset {
        said.push_str("No credentials; `weave credentials set <name>` keeps one.\n");
    }
    let width = credentials
        .iter()
        .map(|credential| credential.name.chars().count())
        .max()
        .unwrap_or(0);
    for credential in credentials {
        said.push_str(&format!(
            "{:width$}  {}, set {} ago\n",
            credential.name,
            kind_of(credential),
            ago(now_ms, credential.updated_at),
        ));
    }
    said
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::*;

    #[test]
    fn credentials_are_listed_with_whether_they_can_be_read() {
        let status = |state, count| CredentialsStatus { state, count };
        assert_eq!(
            describe(&status(CredentialsState::Unset, 0), &[], 0),
            "The Dispatcher keeps no credentials yet; `weave credentials unlock` sets the \
             passphrase they're encrypted under.\n"
        );
        assert_eq!(
            describe(&status(CredentialsState::Unlocked, 0), &[], 0),
            "Unlocked.\nNo credentials; `weave credentials set <name>` keeps one.\n"
        );
        let credentials = [
            Credential {
                name: "claude".to_owned(),
                kind: CredentialKind::SignIn,
                agent: Some("claude".to_owned()),
                created_at: 0,
                updated_at: 0,
            },
            Credential {
                name: "git".to_owned(),
                kind: CredentialKind::Token,
                agent: None,
                created_at: 0,
                updated_at: 0,
            },
        ];
        let listed = describe(&status(CredentialsState::Locked, 2), &credentials, 0);
        assert!(
            listed.starts_with("Locked: `weave credentials unlock`"),
            "{listed}"
        );
        assert!(
            listed.contains("claude  a sign-in for claude, set 0s ago"),
            "{listed}"
        );
        assert!(listed.contains("git     a token, set 0s ago"), "{listed}");
    }
}
