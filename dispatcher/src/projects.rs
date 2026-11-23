//! The person's Projects (ADR 0031, WVE-189), which the Dispatcher keeps as the one of their
//! programs that sees every Host: each named, with at most one location on each Host, a
//! repository by its primary worktree or a directory outside one. Clients find out where a
//! directory lies in git from its Host and say so here; Hosts know nothing of Projects. Its own
//! computer and paired devices may change them. Hosts' agents read them, with the Host tool
//! `list_projects` ([`crate::calls`]), and name one to the thread tools; they change none. A
//! git Project's remote follows what a Host that resolves remotes reports for a location's
//! repository through its open threads (WVE-213, [`crate::link`]).

use std::path::Path;
use std::sync::Arc;

use agent_client_protocol::Error;
use weave_host_protocol::dispatcher::AddProjectRequest;
use weave_host_protocol::dispatcher::Project;
use weave_host_protocol::dispatcher::UpdateProjectRequest;

use crate::Shared;
use crate::internal;
use crate::invalid;
use crate::store::Change;
use crate::store::ProjectError;
use crate::store::StoredHost;

impl Shared {
    pub(crate) fn projects(&self) -> Result<Vec<Project>, Error> {
        self.store.projects().map_err(internal)
    }

    /// The Project `by` names, by id or name, ignoring case.
    pub(crate) fn project(&self, by: &str) -> Result<Project, Error> {
        self.store
            .project(by)
            .map_err(internal)?
            .ok_or_else(|| invalid(format!("there's no Project {by}")))
    }

    pub(crate) fn add_project(
        self: &Arc<Self>,
        request: AddProjectRequest,
    ) -> Result<Project, Error> {
        let project = self
            .store
            .add_project(
                &request.name,
                &request.location,
                request.git_credential.as_deref(),
            )
            .map_err(refused)?;
        tracing::info!(project = %project.name, kind = project.kind.name(), "added a Project");
        if project.git_credential.is_some() {
            self.sync_credentials();
            self.credentials_changed.notify_one();
        }
        Ok(project)
    }

    pub(crate) fn update_project(
        self: &Arc<Self>,
        request: UpdateProjectRequest,
    ) -> Result<Project, Error> {
        let change = Change {
            name: request.name,
            remove_host: request.remove_host,
            add: request.add,
            git_credential: request.git_credential,
        };
        let project = self
            .store
            .update_project(&request.project, change)
            .map_err(refused)?;
        tracing::info!(project = %project.name, "changed a Project");
        self.sync_credentials();
        self.credentials_changed.notify_one();
        Ok(project)
    }

    /// Note the remote `host`, a Host that resolves remotes (WVE-213), reports for the
    /// repository at `repo` there, which a git Project located there follows
    /// ([`crate::store::Store::reported_remote`]).
    pub(crate) fn reported_remote(self: &Arc<Self>, host: &StoredHost, repo: &Path, remote: &str) {
        match self.store.reported_remote(&host.host_id, repo, remote) {
            Ok(Some(project)) => {
                tracing::info!(
                    project = %project.name,
                    host = %host.host_id,
                    remote,
                    "a Project's remote is now what a Host it's on reports"
                );
                if project.git_credential.is_some() {
                    self.sync_credentials();
                }
            }
            Ok(None) => {}
            Err(why) => {
                tracing::warn!(host = %host.host_id, %why, "noting a repository's remote failed")
            }
        }
    }

    pub(crate) fn remove_project(self: &Arc<Self>, by: &str) -> Result<(), Error> {
        let project = self.store.remove_project(by).map_err(refused)?;
        tracing::info!(project = %project.name, "removed a Project");
        if project.git_credential.is_some() {
            self.sync_credentials();
            self.credentials_changed.notify_one();
        }
        Ok(())
    }
}

fn refused(error: ProjectError) -> Error {
    match error {
        ProjectError::Refused(why) => invalid(why),
        ProjectError::Failed(why) => internal(why),
    }
}
