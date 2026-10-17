"use client";

/**
 * Create or edit an item in an Arc dialog: a title, a description and a status. The service checks the fields again,
 * and a 422 lands next to the field it is about (ApiError.fields); any other failure shows in the dialog. One primary
 * action; Escape or Cancel closes without saving.
 */
import { useState, type FormEvent } from "react";
import { Button } from "@/components/arc/button/button";
import { Dialog, DialogContent } from "@/components/arc/dialog/dialog";
import { Input } from "@/components/arc/input/input";
import { Select } from "@/components/arc/select/select";
import { Textarea } from "@/components/arc/textarea/textarea";
import { ErrorAlert } from "@/components/foundation/feedback/error-alert";
import { ApiError } from "@/lib/errors";
import type { ItemInput } from "../api";
import { STATUS_LABELS, type ItemStatus } from "../types";
import styles from "./demo.module.css";

export interface ItemFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "create" | "edit";
  initial?: ItemInput;
  /** Saves; rejects with ApiError. */
  onSubmit: (input: ItemInput) => Promise<unknown>;
}

const EMPTY: ItemInput = { title: "", description: "", status: "draft" };

export function ItemFormDialog({ open, onOpenChange, mode, initial = EMPTY, onSubmit }: ItemFormDialogProps) {
  // Each opening starts from `initial` again; the dialog stays mounted while it animates out.
  const [round, setRound] = useState(0);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setRound(round + 1);
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={mode === "create" ? "New item" : "Edit item"} description={mode === "create" ? "It is yours alone until you share it." : undefined} className={styles.dialog}>
        <ItemForm key={round} mode={mode} initial={initial} onSubmit={onSubmit} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function ItemForm({ mode, initial, onSubmit, onDone }: { mode: "create" | "edit"; initial: ItemInput; onSubmit: ItemFormDialogProps["onSubmit"]; onDone: () => void }) {
  const [input, setInput] = useState<ItemInput>(initial);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<ApiError | null>(null);
  const [tried, setTried] = useState(false);
  const fields = failure?.fields ?? {};
  const titleProblem = tried && !input.title.trim() ? "Give the item a title." : fields.title;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setTried(true);
    if (!input.title.trim()) return;
    setPending(true);
    setFailure(null);
    try {
      await onSubmit({ ...input, title: input.title.trim(), description: input.description.trim() });
      onDone();
    } catch (error) {
      setFailure(ApiError.from(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <form className={styles.form} onSubmit={submit} noValidate>
      <Input label="Title" name="title" value={input.title} maxLength={120} autoFocus required error={titleProblem} onChange={event => setInput({ ...input, title: event.currentTarget.value })} />
      <Textarea label="Description" name="description" value={input.description} rows={4} description="Optional. Plain text, up to 2,000 characters." error={fields.description} onChange={event => setInput({ ...input, description: event.currentTarget.value })} />
      <Select label="Status" value={input.status} options={(Object.keys(STATUS_LABELS) as ItemStatus[]).map(value => ({ value, label: STATUS_LABELS[value] }))} onValueChange={value => setInput({ ...input, status: value as ItemStatus })} />
      {failure && !Object.keys(fields).length ? <ErrorAlert error={failure} title={mode === "create" ? "The item was not created" : "The changes were not saved"} /> : null}
      <div className={styles.formActions}>
        <Button type="button" variant="ghost" onClick={onDone}>Cancel</Button>
        <Button type="submit" loading={pending}>{mode === "create" ? "Create item" : "Save changes"}</Button>
      </div>
    </form>
  );
}
