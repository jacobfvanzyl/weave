//! Non-secret cloud machine settings (ADR 0036, WVE-238, WVE-239), kept in migration 17's
//! single-row `machine_settings` table. Secrets stay in `credentials`.

use rusqlite::OptionalExtension as _;
use rusqlite::params;
use weave_host_protocol::dispatcher::MachineSettings;
use weave_host_protocol::dispatcher::UpdateMachineSettingsRequest;

use super::Store;
use super::failed;

fn clean(field: &str, value: Option<String>) -> Result<Option<String>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.chars().any(char::is_control) {
        return Err(format!("{field} must be one line of text"));
    }
    Ok(Some(trimmed.to_owned()))
}

fn apply(
    slot: &mut Option<String>,
    field: &str,
    change: &Option<Option<String>>,
) -> Result<(), String> {
    if let Some(value) = change {
        *slot = clean(field, value.clone())?;
    }
    Ok(())
}

impl Store {
    /// The cloud machine settings, or all defaults when none were saved yet.
    pub(crate) fn machine_settings(&self) -> Result<MachineSettings, String> {
        let row = self
            .lock()
            .query_row(
                "SELECT fly_app, fly_org, fly_region, fly_credential, image, \
                        tailscale_client_id, tailscale_credential, tailscale_tag \
                 FROM machine_settings WHERE id = 1",
                [],
                |row| {
                    Ok(MachineSettings {
                        fly_app: row.get(0)?,
                        fly_org: row.get(1)?,
                        fly_region: row.get(2)?,
                        fly_credential: row.get(3)?,
                        image: row.get(4)?,
                        tailscale_client_id: row.get(5)?,
                        tailscale_credential: row.get(6)?,
                        tailscale_tag: row.get(7)?,
                    })
                },
            )
            .optional()
            .map_err(failed)?;
        Ok(row.unwrap_or_default())
    }

    /// Update the non-secret cloud machine settings, returning the saved values.
    pub(crate) fn update_machine_settings(
        &self,
        request: &UpdateMachineSettingsRequest,
    ) -> Result<MachineSettings, String> {
        let mut settings = self.machine_settings()?;
        apply(&mut settings.fly_app, "flyApp", &request.fly_app)?;
        apply(&mut settings.fly_org, "flyOrg", &request.fly_org)?;
        apply(&mut settings.fly_region, "flyRegion", &request.fly_region)?;
        apply(
            &mut settings.fly_credential,
            "flyCredential",
            &request.fly_credential,
        )?;
        apply(&mut settings.image, "image", &request.image)?;
        apply(
            &mut settings.tailscale_client_id,
            "tailscaleClientId",
            &request.tailscale_client_id,
        )?;
        apply(
            &mut settings.tailscale_credential,
            "tailscaleCredential",
            &request.tailscale_credential,
        )?;
        apply(
            &mut settings.tailscale_tag,
            "tailscaleTag",
            &request.tailscale_tag,
        )?;
        self.lock()
            .execute(
                "INSERT INTO machine_settings \
                     (id, fly_app, fly_org, fly_region, fly_credential, image, \
                      tailscale_client_id, tailscale_credential, tailscale_tag) \
                 VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) \
                 ON CONFLICT (id) DO UPDATE SET \
                     fly_app = excluded.fly_app, \
                     fly_org = excluded.fly_org, \
                     fly_region = excluded.fly_region, \
                     fly_credential = excluded.fly_credential, \
                     image = excluded.image, \
                     tailscale_client_id = excluded.tailscale_client_id, \
                     tailscale_credential = excluded.tailscale_credential, \
                     tailscale_tag = excluded.tailscale_tag",
                params![
                    settings.fly_app,
                    settings.fly_org,
                    settings.fly_region,
                    settings.fly_credential,
                    settings.image,
                    settings.tailscale_client_id,
                    settings.tailscale_credential,
                    settings.tailscale_tag,
                ],
            )
            .map_err(failed)?;
        Ok(settings)
    }
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::*;

    #[test]
    fn machine_settings_round_trip_and_clear() {
        let store = Store::in_memory();
        assert_eq!(
            store.machine_settings().expect("default"),
            MachineSettings::default()
        );
        let updated = store
            .update_machine_settings(&UpdateMachineSettingsRequest {
                fly_app: Some(Some(" weave-hosts ".to_owned())),
                fly_region: Some(Some("jnb".to_owned())),
                image: Some(Some("registry.fly.io/weave-hosts:latest".to_owned())),
                tailscale_client_id: Some(Some("k123456CNTRL".to_owned())),
                ..UpdateMachineSettingsRequest::default()
            })
            .expect("updated");
        assert_eq!(updated.fly_app.as_deref(), Some("weave-hosts"));
        assert_eq!(updated.fly_region.as_deref(), Some("jnb"));
        assert_eq!(
            updated.image.as_deref(),
            Some("registry.fly.io/weave-hosts:latest")
        );
        assert_eq!(updated.tailscale_client_id.as_deref(), Some("k123456CNTRL"));

        // Clearing one field leaves the rest intact.
        let cleared = store
            .update_machine_settings(&UpdateMachineSettingsRequest {
                tailscale_client_id: Some(None),
                ..UpdateMachineSettingsRequest::default()
            })
            .expect("cleared");
        assert_eq!(cleared.fly_app.as_deref(), Some("weave-hosts"));
        assert_eq!(cleared.tailscale_client_id, None);
        assert_eq!(store.machine_settings().expect("read"), cleared);

        // Control characters are refused.
        assert!(
            store
                .update_machine_settings(&UpdateMachineSettingsRequest {
                    fly_app: Some(Some("bad\napp".to_owned())),
                    ..UpdateMachineSettingsRequest::default()
                })
                .is_err()
        );
    }
}
