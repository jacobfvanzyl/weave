//! The two ends of a Host connection, and of one to the Dispatcher, as the ACP SDK's JSON-RPC
//! layer names them. Messages nobody handles fall through: requests are answered "method not
//! found", and notifications are ignored, as a client must ignore what a newer Host sends.

use std::future::Future;

use agent_client_protocol::ConnectionTo;
use agent_client_protocol::Dispatch;
use agent_client_protocol::Error;
use agent_client_protocol::Handled;
use agent_client_protocol::Role;
use agent_client_protocol::RoleId;
use agent_client_protocol::role::HasPeer;
use agent_client_protocol::role::RemoteStyle;

/// The Host's end of a connection.
#[derive(Copy, Clone, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Host;

/// A client's end of a connection.
#[derive(Copy, Clone, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct HostClient;

impl Role for Host {
    type Counterpart = HostClient;

    fn role_id(&self) -> RoleId {
        RoleId::from_singleton(self)
    }

    fn default_handle_dispatch_from(
        &self,
        message: Dispatch,
        _connection: ConnectionTo<Self>,
    ) -> impl Future<Output = Result<Handled<Dispatch>, Error>> + Send {
        std::future::ready(Ok(Handled::No {
            message,
            retry: false,
        }))
    }

    fn counterpart(&self) -> Self::Counterpart {
        HostClient
    }
}

impl HasPeer<Host> for Host {
    fn remote_style(&self, _peer: Host) -> RemoteStyle {
        RemoteStyle::Counterpart
    }
}

impl Role for HostClient {
    type Counterpart = Host;

    fn role_id(&self) -> RoleId {
        RoleId::from_singleton(self)
    }

    fn default_handle_dispatch_from(
        &self,
        message: Dispatch,
        _connection: ConnectionTo<Self>,
    ) -> impl Future<Output = Result<Handled<Dispatch>, Error>> + Send {
        std::future::ready(Ok(Handled::No {
            message,
            retry: false,
        }))
    }

    fn counterpart(&self) -> Self::Counterpart {
        Host
    }
}

impl HasPeer<HostClient> for HostClient {
    fn remote_style(&self, _peer: HostClient) -> RemoteStyle {
        RemoteStyle::Counterpart
    }
}

/// The Dispatcher's end of a connection to it (ADR 0027).
#[derive(Copy, Clone, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Dispatcher;

/// A client's end of a connection to the Dispatcher.
#[derive(Copy, Clone, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct DispatcherClient;

impl Role for Dispatcher {
    type Counterpart = DispatcherClient;

    fn role_id(&self) -> RoleId {
        RoleId::from_singleton(self)
    }

    fn default_handle_dispatch_from(
        &self,
        message: Dispatch,
        _connection: ConnectionTo<Self>,
    ) -> impl Future<Output = Result<Handled<Dispatch>, Error>> + Send {
        std::future::ready(Ok(Handled::No {
            message,
            retry: false,
        }))
    }

    fn counterpart(&self) -> Self::Counterpart {
        DispatcherClient
    }
}

impl HasPeer<Dispatcher> for Dispatcher {
    fn remote_style(&self, _peer: Dispatcher) -> RemoteStyle {
        RemoteStyle::Counterpart
    }
}

impl Role for DispatcherClient {
    type Counterpart = Dispatcher;

    fn role_id(&self) -> RoleId {
        RoleId::from_singleton(self)
    }

    fn default_handle_dispatch_from(
        &self,
        message: Dispatch,
        _connection: ConnectionTo<Self>,
    ) -> impl Future<Output = Result<Handled<Dispatch>, Error>> + Send {
        std::future::ready(Ok(Handled::No {
            message,
            retry: false,
        }))
    }

    fn counterpart(&self) -> Self::Counterpart {
        Dispatcher
    }
}

impl HasPeer<DispatcherClient> for DispatcherClient {
    fn remote_style(&self, _peer: DispatcherClient) -> RemoteStyle {
        RemoteStyle::Counterpart
    }
}
