import { useEffect, useRef, useState, type CSSProperties, type ChangeEvent } from "react";
import { AppearanceProfileSchema, type AppearanceProfile } from "@agni/protocol";
import { Check, Download, Image, Plus, RotateCcw, Trash2, Upload } from "lucide-react";
import { ACCENTS, PRESETS, accentColor, appearanceVariables, defaultAppearance, newAppearanceID } from "../appearance";
import { useAppModel, useAppSnapshot } from "../state/use-app-model";

function clone(profile: AppearanceProfile): AppearanceProfile {
  return structuredClone(profile);
}

async function normalizeImage(file: File): Promise<File> {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) throw new Error("Choose a PNG, JPEG, or WebP image.");
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 3840 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser cannot process the image.");
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const mime = file.type === "image/png" ? "image/png" : "image/webp";
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mime, 0.9));
  if (!blob) throw new Error("The background could not be prepared.");
  if (blob.size > 10 * 1024 * 1024) throw new Error("The processed background is still larger than 10 MB.");
  return new File([blob], `background.${mime === "image/png" ? "png" : "webp"}`, { type: mime });
}

export function AppearanceView() {
  const model = useAppModel();
  const snapshot = useAppSnapshot();
  const [draft, setDraft] = useState(() => clone(snapshot.appearance));
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewBackgroundURL, setPreviewBackgroundURL] = useState<string | null>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const imageRef = useRef<HTMLInputElement>(null);
  const prefersDark = typeof matchMedia === "undefined" || matchMedia("(prefers-color-scheme: dark)").matches;
  const draftAssetID = draft.background.kind === "image" ? draft.background.assetID : null;

  useEffect(() => setDraft(clone(snapshot.appearance)), [snapshot.appearance]);
  useEffect(() => {
    if (!draftAssetID) { setPreviewBackgroundURL(null); return; }
    const controller = new AbortController(); let url: string | null = null;
    void model.backgroundBlob(draftAssetID, controller.signal).then((blob) => {
      url = URL.createObjectURL(blob); setPreviewBackgroundURL(url);
    }).catch(() => setPreviewBackgroundURL(null));
    return () => { controller.abort(); if (url) URL.revokeObjectURL(url); };
  }, [draftAssetID, model]);
  const update = <K extends keyof AppearanceProfile>(key: K, value: AppearanceProfile[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));
  const dirty = JSON.stringify({ ...draft, updatedAt: "" }) !== JSON.stringify({ ...snapshot.appearance, updatedAt: "" });

  const uploadBackground = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setBusy(true); setError(null);
    try {
      const normalized = await normalizeImage(file);
      const { id } = await model.uploadBackground(normalized);
      update("background", { kind: "image", assetID: id, fit: "cover", positionX: 50, positionY: 50, dim: 0.68, blur: 0 });
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  const importTheme = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; event.target.value = "";
    if (!file) return;
    try {
      const parsed = AppearanceProfileSchema.parse(JSON.parse(await file.text()));
      setDraft({ ...parsed, id: newAppearanceID(), name: `${parsed.name} copy`, background: parsed.background.kind === "image" ? { kind: "none" } : parsed.background });
      setError(null);
    } catch { setError("That file is not a valid Agni theme."); }
  };

  const exportTheme = () => {
    const exported = { ...draft, background: draft.background.kind === "image" ? { kind: "none" as const } : draft.background };
    const url = URL.createObjectURL(new Blob([JSON.stringify(exported, null, 2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = `${draft.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase() || "agni-theme"}.agni-theme.json`; link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="settings-section appearance-settings">
      <div className="appearance-toolbar">
        <label>Profile<select value={snapshot.appearance.id} onChange={(event) => model.activateAppearance(event.target.value)}>{snapshot.appearanceProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label>
        <label>Name<input type="text" maxLength={64} value={draft.name} onChange={(event) => update("name", event.target.value)} /></label>
        <button className="btn secondary" type="button" onClick={() => setDraft({ ...clone(draft), id: newAppearanceID(), name: `${draft.name} copy` })}><Plus size={13} /> Save as new</button>
        <button className="btn secondary" type="button" onClick={exportTheme}><Download size={13} /> Export</button>
        <button className="btn secondary" type="button" onClick={() => importRef.current?.click()}><Upload size={13} /> Import</button>
        <input ref={importRef} hidden type="file" accept=".json,.agni-theme.json,application/json" onChange={importTheme} />
      </div>

      <div className="appearance-preview" style={appearanceVariables(draft, prefersDark, model.agent?.color, previewBackgroundURL) as CSSProperties}>
        <div className="appearance-preview-sidebar"><span className="preview-flame">◆</span><i /><i /><i /></div>
        <div className="appearance-preview-chat"><strong>{draft.name}</strong><div className="preview-message assistant">Markdown, code and attachments stay readable.</div><div className="preview-message owner">Your theme, your Agni.</div><code>const fast = true;</code></div>
      </div>

      <section className="settings-group"><h3>Theme</h3><div className="theme-grid">{PRESETS.map((preset) => <button key={preset.id} type="button" className={`theme-card${draft.preset === preset.id ? " selected" : ""}`} onClick={() => update("preset", preset.id)}><span className="theme-card-colors" style={{ background: `linear-gradient(135deg, ${preset.colors[0]} 50%, ${preset.colors[1]} 50%)` }} />{preset.name}{draft.preset === preset.id ? <Check size={13} /> : null}</button>)}</div><div className="segmented">{(["system", "dark", "light"] as const).map((mode) => <button key={mode} className={draft.mode === mode ? "selected" : ""} onClick={() => update("mode", mode)}>{mode[0]?.toUpperCase()}{mode.slice(1)}</button>)}</div></section>

      <section className="settings-group"><h3>Accent palette</h3><div className="accent-grid">{ACCENTS.map((accent) => <button key={accent.id} type="button" aria-label={accent.name} title={accent.name} className={draft.accent === accent.id ? "selected" : ""} style={{ "--swatch": accent.color } as CSSProperties} onClick={() => update("accent", accent.id)} />)}<label className={`custom-swatch${draft.accent === "custom" ? " selected" : ""}`} title="Custom"><input type="color" value={draft.customAccent ?? "#ff3146"} onChange={(event) => setDraft((current) => ({ ...current, accent: "custom", customAccent: event.target.value }))} /></label></div><span className="settings-note">Selected accent: {accentColor(draft)}</span></section>

      <section className="settings-group"><h3>Background</h3><div className="segmented">{(["none", "solid", "gradient", "image"] as const).map((kind) => <button key={kind} className={draft.background.kind === kind ? "selected" : ""} onClick={() => { if (kind === "none") update("background", { kind: "none" }); if (kind === "solid") update("background", { kind: "solid", color: "#111827" }); if (kind === "gradient") update("background", { kind: "gradient", from: "#111827", to: "#3b1520", angle: 135 }); if (kind === "image") imageRef.current?.click(); }}>{kind[0]?.toUpperCase()}{kind.slice(1)}</button>)}</div>
        {draft.background.kind === "solid" ? <label className="appearance-inline">Color<input type="color" value={draft.background.color} onChange={(event) => { const color = event.target.value; setDraft((current) => current.background.kind === "solid" ? { ...current, background: { ...current.background, color } } : current); }} /></label> : null}
        {draft.background.kind === "gradient" ? <div className="appearance-inline"><label>From<input type="color" value={draft.background.from} onChange={(event) => { const from = event.target.value; setDraft((current) => current.background.kind === "gradient" ? { ...current, background: { ...current.background, from } } : current); }} /></label><label>To<input type="color" value={draft.background.to} onChange={(event) => { const to = event.target.value; setDraft((current) => current.background.kind === "gradient" ? { ...current, background: { ...current.background, to } } : current); }} /></label><label>Angle<input type="range" min="0" max="360" value={draft.background.angle} onChange={(event) => { const angle = Number(event.target.value); setDraft((current) => current.background.kind === "gradient" ? { ...current, background: { ...current.background, angle } } : current); }} /></label></div> : null}
        {draft.background.kind === "image" ? <div className="background-controls"><button type="button" className="btn secondary" onClick={() => imageRef.current?.click()}><Image size={13} /> {busy ? "Preparing…" : "Change image"}</button><label>Dim <input type="range" min="0" max="0.95" step="0.05" value={draft.background.dim} onChange={(event) => { const dim = Number(event.target.value); setDraft((current) => current.background.kind === "image" ? { ...current, background: { ...current.background, dim } } : current); }} /></label><label>Blur <input type="range" min="0" max="24" value={draft.background.blur} onChange={(event) => { const blur = Number(event.target.value); setDraft((current) => current.background.kind === "image" ? { ...current, background: { ...current.background, blur } } : current); }} /></label><label>Fit <select value={draft.background.fit} onChange={(event) => { const fit = event.target.value as "cover" | "contain"; setDraft((current) => current.background.kind === "image" ? { ...current, background: { ...current.background, fit } } : current); }}><option value="cover">Cover</option><option value="contain">Contain</option></select></label></div> : null}
        <input ref={imageRef} hidden type="file" accept="image/png,image/jpeg,image/webp" onChange={uploadBackground} />{error ? <div className="appearance-error">{error}</div> : null}
      </section>

      <button type="button" className="advanced-toggle" onClick={() => setAdvanced((value) => !value)}>Advanced <span>{advanced ? "−" : "+"}</span></button>
      {advanced ? <section className="settings-group appearance-advanced">
        <Choice label="Text size" value={draft.textScale} options={["small", "default", "large"]} onChange={(value) => update("textScale", value as AppearanceProfile["textScale"])} />
        <Choice label="Density" value={draft.density} options={["compact", "comfortable"]} onChange={(value) => update("density", value as AppearanceProfile["density"])} />
        <Choice label="Corners" value={draft.corners} options={["square", "standard", "soft"]} onChange={(value) => update("corners", value as AppearanceProfile["corners"])} />
        <Choice label="Motion" value={draft.motion} options={["system", "full", "reduced"]} onChange={(value) => update("motion", value as AppearanceProfile["motion"])} />
        <Choice label="Agent color" value={draft.agentTint} options={["full", "subtle", "off"]} onChange={(value) => update("agentTint", value as AppearanceProfile["agentTint"])} />
      </section> : null}

      <div className="appearance-actions"><button type="button" className="btn secondary" onClick={() => setDraft({ ...defaultAppearance(), id: draft.id, name: draft.name })}><RotateCcw size={13} /> Reset</button>{snapshot.appearanceProfiles.length > 1 ? <button type="button" className="btn danger" onClick={() => model.deleteAppearance(snapshot.appearance.id)}><Trash2 size={13} /> Delete profile</button> : null}<span /><button type="button" className="btn secondary" disabled={!dirty} onClick={() => setDraft(clone(snapshot.appearance))}>Cancel</button><button type="button" className="btn primary" disabled={!dirty || busy || !draft.name.trim()} onClick={() => model.saveAppearance(draft)}><Check size={13} /> Apply</button></div>
    </div>
  );
}

function Choice({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (value: string) => void }) {
  return <div className="appearance-choice"><strong>{label}</strong><div className="segmented">{options.map((option) => <button key={option} className={value === option ? "selected" : ""} onClick={() => onChange(option)}>{option[0]?.toUpperCase()}{option.slice(1)}</button>)}</div></div>;
}
