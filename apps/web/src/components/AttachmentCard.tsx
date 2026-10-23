import { useEffect, useState } from "react";
import type { AttachmentInfo } from "@agni/client";
import { FileText, Download, X } from "lucide-react";
import { useAppModel } from "../state/use-app-model";

export function AttachmentCard({ attachment }: { attachment: AttachmentInfo }) {
  const model = useAppModel();
  const [preview, setPreview] = useState<string>();
  const [error, setError] = useState<string>();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (attachment.kind !== "image") return;
    const controller = new AbortController();
    let objectURL: string | undefined;
    void model.attachmentBlob(attachment.id, controller.signal).then((blob) => {
      if (controller.signal.aborted) return;
      objectURL = URL.createObjectURL(blob);
      setPreview(objectURL);
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "Preview unavailable.");
    });
    return () => { controller.abort(); if (objectURL) URL.revokeObjectURL(objectURL); };
  }, [attachment.id, attachment.kind, model]);
  const download = async () => {
    try {
      const url = URL.createObjectURL(await model.attachmentBlob(attachment.id));
      const link = document.createElement("a");
      link.href = url; link.download = attachment.name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { setError(error instanceof Error ? error.message : "Download failed."); }
  };
  return <>
    <div className="attachment-card">
      {preview ? (
        <button
          type="button"
          className="attachment-open"
          aria-label={`Open ${attachment.name}`}
          onClick={() => setOpen(true)}
        >
          <img className="attachment-image" src={preview} alt={attachment.name} />
        </button>
      ) : (
        <FileText size={20} />
      )}
      <div className="attachment-label"><strong>{attachment.name}</strong><span>{Math.max(1, Math.ceil(attachment.size / 1024))} KB</span></div>
      <button type="button" className="attachment-download" aria-label={`Download ${attachment.name}`} onClick={() => void download()}><Download size={16} /></button>
      {error ? <span className="attachment-error" role="alert">{error}</span> : null}
    </div>

    {open && preview ? (
      <div
        className="preview-sheet"
        role="dialog"
        aria-label={attachment.name}
        onClick={(event) => {
          if (event.target === event.currentTarget) setOpen(false);
        }}
      >
        <div className="preview-bar">
          <div className="preview-name">
            <span>{attachment.name}</span>
            <span className="tertiary">{Math.max(1, Math.ceil(attachment.size / 1024))} KB</span>
          </div>
          <button
            type="button"
            className="icon-btn preview-download"
            aria-label={`Download ${attachment.name}`}
            onClick={() => void download()}
          >
            <Download size={15} />
          </button>
          <button
            type="button"
            className="icon-btn preview-close"
            aria-label="Close the preview"
            onClick={() => setOpen(false)}
          >
            <X size={15} />
          </button>
        </div>
        <img className="preview-image" src={preview} alt={attachment.name} />
      </div>
    ) : null}
  </>;
}
