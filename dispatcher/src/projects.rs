//! The person's Projects (ADR 0031, WVE-189), which the Dispatcher keeps as the one of their
//! programs that sees every Host: each named, with at most one location on each Host, a
//! repository by its primary worktree or a directory outside one. Clients find out where a
//! directory lies in git from its Host and say so here; Hosts know nothing of Projects. Its own
//! computer and paired devices may change them. Hosts' agents read them, with the Host tool
//! `list_projects` ([`crate::calls`]), and name one to the thread tools; they change none.

use agent_client_protocol::Error;
use weave_host_protocol::dispatcher::AddProjectRequest;
use weave_host_protocol::dispatcher::Project;
use weave_host_protocol::dispatcher::UpdateProjectRequest;

use crate::Shared;
use crate::internal;
use crate::invalid;
use crate::store::Change;
use crate::store::ProjectError;

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

    pub(crate) fn add_project(&self, request: AddProjectRequest) -> Result<Project, Error> {
        let project = self
            .store
            .add_project(&request.name, &request.location)
            .map_err(refused)?;
        tracing::info!(project = %project.name, kind = project.kind.name(), "added a Project");
        Ok(project)
    }

    pub(crate) fn update_project(&self, request: UpdateProjectRequest) -> Result<Project, Error> {
        let change = Change {
            name: request.name,
            remove_host: request.remove_host,
            add: request.add,
        };
        let project = self
            .store
            .update_project(&request.project, change)
            .map_err(refused)?;
        tracing::info!(project = %project.name, "changed a Project");
        Ok(project)
    }

    pub(crate) fn remove_project(&self, by: &str) -> Result<(), Error> {
        let project = self.store.remove_project(by).map_err(refused)?;
        tracing::info!(project = %project.name, "removed a Project");
        Ok(())
    }
}

fn refused(error: ProjectError) -> Error {
    match error {
        ProjectError::Refused(why) => invalid(why),
        ProjectError::Failed(why) => internal(why),
    }
}
