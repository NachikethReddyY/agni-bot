import { useEffect, useRef, useState, type CSSProperties, type ChangeEvent } from "react";
import { AppearanceProfileSchema, type AppearanceProfile } from "@agni/protocol";
import { Check, Download, Image, RotateCcw, Upload, Undo2 } from "lucide-react";
import { ACCENTS, PRESETS, accentColor, appearanceVariables, contrastRatio, defaultAppearance } from "../appearance";
import { useAppModel, useAppSnapshot } from "../state/use-app-model";

const GRADIENTS = [
  { name: "Dusk", from: "#111827", to: "#3b1520", angle: 135 },
  { name: "Ocean", from: "#052e38", to: "#172554", angle: 135 },
  { name: "Forest", from: "#052e16", to: "#143b3b", angle: 90 },
  { name: "Lavender", from: "#241342", to: "#492136", angle: 45 },
] as const;

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
  const draft = snapshot.appearance;
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [backgroundURL, setBackgroundURL] = useState<string | null>(null);
  const [history, setHistory] = useState<AppearanceProfile[]>([]);
  const gesture = useRef<string | null>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const imageRef = useRef<HTMLInputElement>(null);
  const assetID = draft.background.kind === "image" ? draft.background.assetID : null;
  const [systemDark, setSystemDark] = useState(() => typeof matchMedia === "undefined" || matchMedia("(prefers-color-scheme: dark)").matches);
  useEffect(() => {
    if (typeof matchMedia === "undefined") return;
    const media = matchMedia("(prefers-color-scheme: dark)");
    const changed = () => setSystemDark(media.matches);
    media.addEventListener("change", changed);
    return () => media.removeEventListener("change", changed);
  }, []);
  useEffect(() => {
    const end = () => { gesture.current = null; };
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    return () => { window.removeEventListener("pointerup", end); window.removeEventListener("pointercancel", end); };
  }, []);
  useEffect(() => {
    setBackgroundURL(null);
    if (!assetID) return;
    const controller = new AbortController(); let url: string | null = null;
    void model.backgroundBlob(assetID, controller.signal).then((blob) => {
      if (controller.signal.aborted) return;
      url = URL.createObjectURL(blob); setBackgroundURL(url);
    }).catch(() => { if (!controller.signal.aborted) setError("The background preview could not be loaded."); });
    return () => { controller.abort(); if (url) URL.revokeObjectURL(url); };
  }, [assetID, model]);

  function change(next: AppearanceProfile, group?: string) {
    const current = model.getSnapshot().appearance;
    const content = (p: AppearanceProfile) => JSON.stringify({ ...p, updatedAt: "" });
    if (content(next) === content(current)) return;
    if (!group || gesture.current !== group) setHistory((items) => [...items.slice(-29), structuredClone(current)]);
    gesture.current = group ?? null;
    model.saveAppearance(next);
  }
  function update<K extends keyof AppearanceProfile>(key: K, value: AppearanceProfile[K]) { change({ ...model.getSnapshot().appearance, [key]: value }); }
  function background(patch: Record<string, string | number>, group?: string) {
    const current = model.getSnapshot().appearance;
    change({ ...current, background: { ...current.background, ...patch } as AppearanceProfile["background"] }, group);
  }
  function undo() {
    const previous = history.at(-1);
    if (!previous) return;
    gesture.current = null;
    setHistory((items) => items.slice(0, -1));
    model.saveAppearance(previous);
  }
  const uploadBackground = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; event.target.value = "";
    if (!file) return;
    setBusy(true); setError(null);
    try {
      const { id } = await model.uploadBackground(await normalizeImage(file));
      change({ ...model.getSnapshot().appearance, background: { kind: "image", assetID: id, fit: "cover", positionX: 50, positionY: 50, dim: 0.68, blur: 0 } });
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };
  const importTheme = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; event.target.value = "";
    if (!file) return;
    try {
      const parsed = AppearanceProfileSchema.parse(JSON.parse(await file.text()));
      const current = model.getSnapshot().appearance;
      change({ ...parsed, id: current.id, name: current.name, background: parsed.background.kind === "image" ? { kind: "none" } : parsed.background });
      setError(null);
    } catch { setError("That file is not a valid Agni theme."); }
  };
  const exportTheme = () => {
    const exported = { ...draft, background: draft.background.kind === "image" ? { kind: "none" as const } : draft.background };
    const url = URL.createObjectURL(new Blob([JSON.stringify(exported, null, 2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = "agni-appearance.json"; link.click(); URL.revokeObjectURL(url);
  };
  const bg = draft.background;
  const variables = appearanceVariables(draft, systemDark, model.agent?.color, backgroundURL);
  const status = snapshot.appearanceSaveStatus;
  const accent = accentColor(draft);
  const textContrast = contrastRatio(accent, variables["--surface"]!);
  const backgroundContrast = bg.kind === "solid" ? contrastRatio(variables["--ink"]!, bg.color)
    : bg.kind === "gradient" ? Math.min(contrastRatio(variables["--ink"]!, bg.from), contrastRatio(variables["--ink"]!, bg.to)) : null;
  const endGesture = () => { gesture.current = null; };
  const colour = (label: string, value: string, onChange: (value: string) => void) => <ColorControl label={label} value={value} onChange={onChange} />;

  return <div className="settings-section appearance-settings" onBlurCapture={endGesture} onKeyUp={endGesture}>
    <div className="appearance-toolbar">
      <p className="settings-note">Make it yours. Changes appear instantly.</p>
      <span role="status" className="appearance-save-status">{status === "saved" ? "Saved" : status === "saving" ? "Saving…" : status === "pending" ? "Waiting to sync · reconnecting" : "Could not sync changes"}</span>
      {status === "error" ? <button type="button" className="btn secondary" onClick={() => model.retryAppearanceSave()}>Retry save</button> : null}
    </div>
    <section className="settings-group"><h3>Theme</h3><div className="theme-grid">{PRESETS.map((preset) => <button key={preset.id} type="button" aria-pressed={draft.preset === preset.id} className={`theme-card${draft.preset === preset.id ? " selected" : ""}`} onClick={() => update("preset", preset.id)}><span className="theme-card-colors" style={{ background: `linear-gradient(135deg, ${preset.colors[0]} 50%, ${preset.colors[1]} 50%)` }} />{preset.name}{draft.preset === preset.id ? <Check size={13} /> : null}</button>)}</div><Choice label="Mode" value={draft.mode} options={["system", "dark", "light"]} onChange={(value) => update("mode", value as AppearanceProfile["mode"])} /></section>
    <section className="settings-group"><h3>Colours</h3><div className="accent-grid" role="group" aria-label="Suggested accent colours">{ACCENTS.map((item) => <button key={item.id} type="button" aria-label={item.name} aria-pressed={draft.accent === item.id} title={item.name} className={draft.accent === item.id ? "selected" : ""} style={{ "--swatch": item.color } as CSSProperties} onClick={() => update("accent", item.id)} />)}</div>
      {colour("Custom accent", accent, (customAccent) => change({ ...model.getSnapshot().appearance, accent: "custom", customAccent }, "accent"))}
      <div className="appearance-colour-sample" style={variables as CSSProperties}><span style={{ color: accent }}>Sample accent text</span><span className="appearance-sample-button">Sample button</span><span>Text contrast {textContrast.toFixed(1)}:1</span></div>
      {textContrast < 4.5 ? <p className="settings-note" role="status">This accent may be hard to read as small text on the theme surface. Try a lighter or darker colour.</p> : null}
    </section>
    <section className="settings-group"><h3>Background</h3><div className="segmented">{(["none", "solid", "gradient", "image"] as const).map((kind) => <button key={kind} type="button" aria-pressed={bg.kind === kind} disabled={busy} className={bg.kind === kind ? "selected" : ""} onClick={() => {
      if (kind === bg.kind && kind !== "image") return;
      if (kind === "none") update("background", { kind: "none" });
      if (kind === "solid") update("background", { kind: "solid", color: "#111827" });
      if (kind === "gradient") update("background", { kind: "gradient", from: GRADIENTS[0].from, to: GRADIENTS[0].to, angle: GRADIENTS[0].angle });
      if (kind === "image") imageRef.current?.click();
    }}>{kind[0]?.toUpperCase()}{kind.slice(1)}</button>)}</div>
    {bg.kind === "solid" ? colour("Background colour", bg.color, (color) => background({ color }, "solid")) : null}
    {bg.kind === "gradient" ? <>
      <div className="gradient-presets">{GRADIENTS.map((preset) => <button type="button" key={preset.name} aria-label={`${preset.name} gradient`} title={preset.name} style={{ background: `linear-gradient(${preset.angle}deg, ${preset.from}, ${preset.to})` }} onClick={() => update("background", { kind: "gradient", from: preset.from, to: preset.to, angle: preset.angle })}>{preset.name}</button>)}</div>
      <div className="gradient-preview" role="img" aria-label="Gradient preview" style={{ background: `linear-gradient(${bg.angle}deg, ${bg.from}, ${bg.to})` }} />
      <div className="appearance-inline">{colour("Gradient start", bg.from, (from) => background({ from }, "from"))}{colour("Gradient end", bg.to, (to) => background({ to }, "to"))}</div>
      <label className="appearance-slider">Direction <input type="range" min="0" max="360" value={bg.angle} onChange={(event) => background({ angle: Number(event.target.value) }, "angle")} /><output>{bg.angle}°</output></label>
    </> : null}
    {bg.kind === "image" ? <>
      {backgroundURL ? <img className="background-thumbnail" src={backgroundURL} alt="Current background" /> : null}
      <div className="background-controls"><button type="button" disabled={busy} className="btn secondary" onClick={() => imageRef.current?.click()}><Image size={13} />{busy ? "Preparing…" : "Replace image"}</button><button type="button" className="btn secondary" onClick={() => update("background", { kind: "none" })}>Remove image</button><label>Fit<select value={bg.fit} onChange={(event) => background({ fit: event.target.value })}><option value="cover">Cover</option><option value="contain">Contain</option></select></label></div>
      {([ ["Dimming", "dim", 0.95, 0.05], ["Blur", "blur", 24, 1], ["Horizontal position", "positionX", 100, 1], ["Vertical position", "positionY", 100, 1] ] as const).map(([label, key, max, step]) => <label key={key} className="appearance-slider">{label}<input type="range" min="0" max={max} step={step} value={bg[key]} onChange={(event) => background({ [key]: Number(event.target.value) }, key)} /><output>{key === "blur" ? `${bg[key]}px` : `${Math.round(bg[key] * (key === "dim" ? 100 : 1))}%`}</output></label>)}
    </> : null}
    {backgroundContrast !== null && backgroundContrast < 4.5 ? <p className="settings-note" role="status">Text may be difficult to read on this background. Adjust its colours or switch theme mode.</p> : null}
    <input ref={imageRef} hidden type="file" accept="image/png,image/jpeg,image/webp" onChange={uploadBackground} />
    {busy ? <p role="status">Preparing background…</p> : null}{error ? <div role="alert" className="appearance-error">{error}</div> : null}
    </section>
    <button type="button" className="advanced-toggle" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>More options <span>{advanced ? "−" : "+"}</span></button>
    {advanced ? <section className="settings-group appearance-advanced">
      {colour("Outgoing bubble", draft.bubbleColor ?? "#0070e8", (bubbleColor) => change({ ...model.getSnapshot().appearance, bubbleColor }, "bubble"))}
      <Choice label="Conversation width" value={draft.conversationWidth ?? "wide"} options={["comfortable", "wide"]} onChange={(v) => update("conversationWidth", v as AppearanceProfile["conversationWidth"])} />
      <Choice label="Transparency" value={draft.transparency ?? "subtle"} options={["subtle", "off"]} onChange={(v) => update("transparency", v as AppearanceProfile["transparency"])} />
      <Choice label="Text size" value={draft.textScale} options={["small", "default", "large"]} onChange={(v) => update("textScale", v as AppearanceProfile["textScale"])} />
      <Choice label="Density" value={draft.density} options={["compact", "comfortable"]} onChange={(v) => update("density", v as AppearanceProfile["density"])} />
      <Choice label="Corners" value={draft.corners} options={["square", "standard", "soft"]} onChange={(v) => update("corners", v as AppearanceProfile["corners"])} />
      <Choice label="Motion" value={draft.motion} options={["system", "full", "reduced"]} onChange={(v) => update("motion", v as AppearanceProfile["motion"])} />
      <Choice label="Bot colour" value={draft.agentTint} options={["full", "subtle", "off"]} onChange={(v) => update("agentTint", v as AppearanceProfile["agentTint"])} />
      <div className="appearance-inline"><button type="button" className="btn secondary" onClick={exportTheme}><Download size={13} /> Export appearance</button><button type="button" className="btn secondary" onClick={() => importRef.current?.click()}><Upload size={13} /> Import appearance</button></div>
      <input ref={importRef} hidden type="file" accept=".json,application/json" onChange={importTheme} />
    </section> : null}
    <div className="appearance-actions"><button type="button" className="btn secondary" disabled={!history.length} onClick={undo}><Undo2 size={13} /> Undo</button><button type="button" className="btn secondary" onClick={() => change({ ...defaultAppearance(), id: draft.id, name: draft.name })}><RotateCcw size={13} /> Reset appearance</button></div>
  </div>;
}

function ColorControl({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  const [hex, setHex] = useState(value);
  useEffect(() => setHex(value), [value]);
  const valid = /^#[0-9a-fA-F]{6}$/.test(hex);
  return <div className="colour-control"><label>{label}<input aria-label={`${label} picker`} type="color" value={value} onChange={(event) => onChange(event.target.value)} /></label><input aria-label={`${label} HEX`} aria-invalid={!valid} type="text" spellCheck={false} maxLength={7} value={hex} onChange={(event) => { const next = event.target.value; setHex(next); if (/^#[0-9a-fA-F]{6}$/.test(next)) onChange(next); }} onBlur={() => setHex(value)} />{!valid ? <small>Use # followed by six hex digits.</small> : null}</div>;
}

function Choice({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (value: string) => void }) {
  return <div className="appearance-choice"><strong>{label}</strong><div className="segmented" role="group" aria-label={label}>{options.map((option) => <button type="button" key={option} aria-pressed={value === option} className={value === option ? "selected" : ""} onClick={() => onChange(option)}>{option[0]?.toUpperCase()}{option.slice(1)}</button>)}</div></div>;
}
