//! Keys for machines to join the person's tailnet with (WVE-238), so a launch needs nothing
//! typed. The person makes a Tailscale OAuth client once, allowed only to make auth keys for
//! one tag; each launch mints a key with it that works once, for a node that is removed when
//! it goes away, and that expires in minutes if unused.

use std::time::Duration;

use serde::Deserialize;
use serde_json::json;

use crate::machines::MachineError;

/// Tailscale's API.
pub const DEFAULT_API: &str = "https://api.tailscale.com/api/v2";
/// The tag machines made here carry, unless the person names another.
pub const DEFAULT_TAG: &str = "tag:weave-host";

/// How long a minted key is good for: longer than a launch waits, and not by much.
const KEY_LIFETIME_SECS: u64 = 10 * 60;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// An OAuth client of the person's tailnet with the `auth_keys` scope for `tag`.
#[derive(Clone)]
pub struct TailscaleClient {
    pub client_id: String,
    pub client_secret: String,
    /// The tag the keys it makes give their nodes, which the client must own.
    pub tag: String,
    pub api: String,
}

impl TailscaleClient {
    pub fn new(client_id: impl Into<String>, client_secret: impl Into<String>) -> Self {
        Self {
            client_id: client_id.into(),
            client_secret: client_secret.into(),
            tag: DEFAULT_TAG.to_owned(),
            api: DEFAULT_API.to_owned(),
        }
    }

    /// A key that joins one machine to the tailnet, once.
    pub async fn mint_key(&self, description: &str) -> Result<String, MachineError> {
        let http = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(|error| MachineError(format!("no HTTP client for Tailscale: {error}")))?;

        #[derive(Deserialize)]
        struct Token {
            access_token: String,
        }
        let form = format!(
            "client_id={}&client_secret={}&grant_type=client_credentials",
            form_encoded(&self.client_id),
            form_encoded(&self.client_secret)
        );
        let token: Token = answer(
            "a token",
            http.post(format!("{}/oauth/token", self.api))
                .header("content-type", "application/x-www-form-urlencoded")
                .body(form),
        )
        .await?;

        #[derive(Deserialize)]
        struct Key {
            key: String,
        }
        let wanted = json!({
            "capabilities": { "devices": { "create": {
                "reusable": false,
                "ephemeral": true,
                "preauthorized": true,
                "tags": [self.tag],
            } } },
            "expirySeconds": KEY_LIFETIME_SECS,
            "description": description,
        });
        let key: Key = answer(
            "an auth key",
            http.post(format!("{}/tailnet/-/keys", self.api))
                .bearer_auth(token.access_token)
                .header("content-type", "application/json")
                .body(wanted.to_string()),
        )
        .await?;
        Ok(key.key)
    }
}

/// Send `request` and read its answer, with anything but success an error that leaves the
/// request, and so the secret in it, out.
async fn answer<T: serde::de::DeserializeOwned>(
    what: &str,
    request: reqwest::RequestBuilder,
) -> Result<T, MachineError> {
    let response = request.send().await.map_err(|error| {
        MachineError(format!(
            "Tailscale didn't answer for {what}: {}",
            error.without_url()
        ))
    })?;
    let status = response.status();
    let text = response.text().await.map_err(|error| {
        MachineError(format!("Tailscale's answer for {what} broke off: {error}"))
    })?;
    if !status.is_success() {
        return Err(MachineError(format!(
            "Tailscale refused {what} ({status}): {text}"
        )));
    }
    serde_json::from_str(&text)
        .map_err(|error| MachineError(format!("Tailscale's {what} wasn't as expected: {error}")))
}

/// `value` as a form field: everything but letters, digits and `-._~` as percent escapes.
fn form_encoded(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                encoded.push(char::from(byte));
            }
            other => encoded.push_str(&format!("%{other:02X}")),
        }
    }
    encoded
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::form_encoded;

    #[test]
    fn a_form_field_escapes_what_a_form_would_misread() {
        assert_eq!(form_encoded("tskey-client-kAb_1.x"), "tskey-client-kAb_1.x");
        assert_eq!(form_encoded("a b&c=d+e"), "a%20b%26c%3Dd%2Be");
    }
}
