//! The person's devices paired with the Dispatcher (WVE-176), as they pair with a Host: a
//! one-time code `weave dispatcher pair` shows, good for five minutes, then a signature of each
//! connection's challenge with a P-256 key that never leaves the device. Devices are kept in
//! SQLite ([`crate::store`]); offers, and which connections each device has open, in memory,
//! so revoking a device closes them.

use std::sync::Arc;
use std::sync::Mutex;

use agent_client_protocol::ConnectionTo;
use agent_client_protocol::Error;
use weave_host_protocol::DispatcherClient;
use weave_host_protocol::Timestamp;
use weave_host_protocol::devices::Device;
use weave_host_protocol::devices::DeviceInfo;
use weave_host_protocol::devices::DevicePairedNotification;
use weave_host_protocol::devices::NewDevice;
use weave_host_protocol::dispatcher::dispatcher_auth_message;
use weave_remote::pairing::Closer;
use weave_remote::pairing::Connections;
use weave_remote::pairing::Offers;
use weave_remote::pairing::device_id;
use weave_remote::pairing::signed;
use weave_remote::pairing::verifying_key;

use crate::internal;
use crate::lock;
use crate::now_ms;
use crate::store::Store;
use crate::store::StoredDevice;

#[derive(Default)]
pub(crate) struct Devices {
    /// Each told, when a device takes it, to the connection that asked for it.
    offers: Mutex<Offers<Option<ConnectionTo<DispatcherClient>>>>,
    live: Mutex<Connections>,
}

impl Devices {
    /// A new offer, good for `lifetime_ms`: its code and when it expires.
    pub(crate) fn offer(
        &self,
        name: Option<String>,
        by: ConnectionTo<DispatcherClient>,
        lifetime_ms: Timestamp,
    ) -> (String, Timestamp) {
        lock(&self.offers).offer(name, Some(by), lifetime_ms)
    }

    /// Whether an offer is still good, which keeps remote access on while it is.
    pub(crate) fn offering(&self) -> bool {
        lock(&self.offers).any_live()
    }

    /// Pair `device` with the offer whose code is `code`, which no one can take again. `None`
    /// when there's no such live offer or the key isn't a P-256 point.
    pub(crate) fn pair(
        &self,
        store: &Store,
        code: &str,
        device: NewDevice,
    ) -> Result<Option<DeviceInfo>, Error> {
        if verifying_key(&device.public_key).is_none() {
            return Ok(None);
        }
        let Some(offer) = lock(&self.offers).take(code) else {
            return Ok(None);
        };
        let paired = store.devices().map_err(internal)?;
        let now = now_ms();
        let stored = StoredDevice {
            id: device_id(|id| paired.iter().any(|device| device.id == id)),
            name: offer.name.unwrap_or(device.name),
            public_key: device.public_key,
            paired_at: now,
            last_seen_at: Some(now),
        };
        store.add_device(&stored).map_err(internal)?;
        tracing::info!(device = %stored.id, name = %stored.name, "a device paired");
        if let Some(by) = offer.by {
            let device = stored.listing(1);
            let _ = by.send_notification(DevicePairedNotification { device });
        }
        Ok(Some(info(&stored)))
    }

    /// The device `device_id`, when `signature` is its signature of the challenge `nonce` to
    /// the Dispatcher `dispatcher_id`.
    pub(crate) fn verify(
        &self,
        store: &Store,
        dispatcher_id: &str,
        device_id: &str,
        nonce: &str,
        signature: &str,
    ) -> Result<Option<DeviceInfo>, Error> {
        let Some(stored) = store.device(device_id).map_err(internal)? else {
            return Ok(None);
        };
        let message = dispatcher_auth_message(dispatcher_id, device_id, nonce);
        if !signed(&stored.public_key, &message, signature) {
            return Ok(None);
        }
        store.device_seen(device_id, now_ms()).map_err(internal)?;
        Ok(Some(info(&stored)))
    }

    /// Note a device's connection, for listing and revoking.
    pub(crate) fn connected(&self, device_id: &str, connection: u64, closer: Arc<dyn Closer>) {
        lock(&self.live).connected(device_id, connection, closer);
    }

    pub(crate) fn disconnected(&self, device_id: &str, connection: u64) {
        lock(&self.live).disconnected(device_id, connection);
    }

    pub(crate) fn list(&self, store: &Store) -> Result<Vec<Device>, Error> {
        let devices = store.devices().map_err(internal)?;
        let live = lock(&self.live);
        Ok(devices
            .iter()
            .map(|device| device.listing(live.count(&device.id)))
            .collect())
    }

    /// Forget a device and close its connections with `code`.
    pub(crate) fn revoke(&self, store: &Store, device_id: &str, code: u16) -> Result<(), Error> {
        if !store.remove_device(device_id).map_err(internal)? {
            return Err(Error::invalid_params().data(format!("no device {device_id}")));
        }
        let closers = lock(&self.live).remove(device_id);
        for closer in closers {
            closer.close(code);
        }
        tracing::info!(device = %device_id, "a device was revoked");
        Ok(())
    }
}

fn info(stored: &StoredDevice) -> DeviceInfo {
    DeviceInfo {
        id: stored.id.clone(),
        name: stored.name.clone(),
        service: false,
    }
}
