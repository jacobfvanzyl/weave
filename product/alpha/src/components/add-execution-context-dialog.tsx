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

export function AddExecutionContextDialog({
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
      ({ supportsExecutionContextRegistration }) =>
        supportsExecutionContextRegistration !== false,
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
    if (!controller.actions.addExecutionContext || !hostId || !path.trim()) return;
    setError(undefined);
    try {
      await controller.actions.addExecutionContext({
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
          <DialogTitle>Add directory</DialogTitle>
          <DialogDescription>
            Choose the Host that can access the directory, then enter its
            absolute path on that Host.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => void submit(event)}
        >
          <FieldGroup>
            <Field data-invalid={!connectedHosts.length || undefined}>
              <FieldLabel htmlFor="add-directory-portal">Host</FieldLabel>
              <Select
                value={hostId}
                onValueChange={(value) => setHostId(value ?? "")}
              >
                <SelectTrigger
                  id="add-directory-portal"
                  className="w-full"
                  aria-invalid={!connectedHosts.length || undefined}
                >
                  <SelectValue placeholder="Choose a connected Host">
                    {connectedHosts.find((host) => host.hostId === hostId)?.[controller.model.showHostIdentity ? 'displayName' : 'hostUrl']}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {connectedHosts.map((host) => (
                      <SelectItem key={host.hostId} value={host.hostId}>
                        {controller.model.showHostIdentity ? host.displayName : host.hostUrl}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              {!connectedHosts.length && (
                <FieldError>
                  Connect a Host before adding a directory.
                </FieldError>
              )}
            </Field>
            <Field data-invalid={Boolean(error) || undefined}>
              <FieldLabel htmlFor="add-directory-path">Directory path</FieldLabel>
              <Input
                id="add-directory-path"
                value={path}
                placeholder="/absolute/path/to/directory"
                autoComplete="off"
                aria-invalid={Boolean(error) || undefined}
                onChange={(event) => setPath(event.target.value)}
              />
              <FieldDescription>
                The directory must already exist on the selected Host.
              </FieldDescription>
              {error && <FieldError>{error}</FieldError>}
            </Field>
            <Field>
              <FieldLabel htmlFor="add-directory-name">
                Name (optional)
              </FieldLabel>
              <Input
                id="add-directory-name"
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
                !controller.actions.addExecutionContext ||
                !hostId ||
                !path.trim()}
            >
              Add directory
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
