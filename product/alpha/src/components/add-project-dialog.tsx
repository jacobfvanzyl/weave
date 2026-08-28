import { type FormEvent, useEffect, useState } from "react";
import type { AlphaController } from "@/app/alpha-controller";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function AddProjectDialog({
  controller,
  open,
  onOpenChange,
}: {
  controller: AlphaController;
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const connectedHosts = controller.model.connections
    .filter(({ status }) => status === "connected")
    .filter(
      ({ supportsProjectRegistration }) =>
        supportsProjectRegistration !== false,
    );
  const [hostId, setHostId] = useState("");
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!open) return;
    setHostId((current) =>
      connectedHosts.some((host) => host.hostId === current)
        ? current
        : (connectedHosts[0]?.hostId ?? "")
    );
  }, [connectedHosts, open]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!controller.actions.addProject || !hostId || !path.trim()) return;
    setError(undefined);
    try {
      await controller.actions.addProject({
        hostId,
        path: path.trim(),
        ...(name.trim() ? { name: name.trim() } : {}),
      });
      setPath("");
      setName("");
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add project</DialogTitle>
          <DialogDescription>
            Choose the Portal that can access the project, then enter its
            absolute path on that Host.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => void submit(event)}
        >
          <FieldGroup>
            <Field data-invalid={!connectedHosts.length || undefined}>
              <FieldLabel htmlFor="add-project-portal">Portal</FieldLabel>
              <Select
                value={hostId}
                onValueChange={(value) => setHostId(value ?? "")}
              >
                <SelectTrigger
                  id="add-project-portal"
                  className="w-full"
                  aria-invalid={!connectedHosts.length || undefined}
                >
                  <SelectValue placeholder="Choose a connected Portal">
                    {connectedHosts.find((host) => host.hostId === hostId)
                      ?.displayName}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {connectedHosts.map((host) => (
                      <SelectItem key={host.hostId} value={host.hostId}>
                        {host.displayName}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              {!connectedHosts.length && (
                <FieldError>
                  Connect a Portal before adding a project.
                </FieldError>
              )}
            </Field>
            <Field data-invalid={Boolean(error) || undefined}>
              <FieldLabel htmlFor="add-project-path">Project path</FieldLabel>
              <Input
                id="add-project-path"
                value={path}
                placeholder="/absolute/path/to/project"
                autoComplete="off"
                aria-invalid={Boolean(error) || undefined}
                onChange={(event) => setPath(event.target.value)}
              />
              <FieldDescription>
                The directory must already exist on the selected Portal Host.
              </FieldDescription>
              {error && <FieldError>{error}</FieldError>}
            </Field>
            <Field>
              <FieldLabel htmlFor="add-project-name">
                Name (optional)
              </FieldLabel>
              <Input
                id="add-project-name"
                value={name}
                placeholder="Derived from the folder name"
                autoComplete="off"
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button
              type="submit"
              disabled={controller.model.busy ||
                !controller.actions.addProject ||
                !hostId ||
                !path.trim()}
            >
              Add project
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
