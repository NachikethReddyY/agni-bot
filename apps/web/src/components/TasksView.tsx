import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, Check, Plus, RefreshCw, X, Mic, Paperclip, Activity, MoreHorizontal } from "lucide-react";
import { format, type TaskInfo } from "@agni/client";
import { useAppModel, useAppSnapshot } from "../state/use-app-model";

export function TasksView() {
  const model = useAppModel();
  const snapshot = useAppSnapshot();
  useEffect(() => {
    const timer = window.setInterval(() => model.refreshTasks(), 3_000);
    return () => window.clearInterval(timer);
  }, [model]);
  const [month, setMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const [calendarDay, setCalendarDay] = useState<Date | null>(null);
  const [creatingFor, setCreatingFor] = useState<string | null | undefined>(undefined);
  const [activityTask, setActivityTask] = useState<TaskInfo | null>(null);
  const [detailTask, setDetailTask] = useState<TaskInfo | null>(null);
  const open = snapshot.tasks.filter((task) => task.status !== "done");
  const today = new Date();
  const todayTasks = open.filter((task) => taskSchedule(task) && dateKey(new Date(taskSchedule(task)!)) <= dateKey(today));
  const overdueTasks = todayTasks.filter((task) => dateKey(new Date(taskSchedule(task)!)) < dateKey(today));
  const dueTodayTasks = todayTasks.filter((task) => dateKey(new Date(taskSchedule(task)!)) === dateKey(today));
  const upcoming = open.filter((task) => taskSchedule(task) && dateKey(new Date(taskSchedule(task)!)) > dateKey(today));
  const inbox = open.filter((task) => (task.listID ?? "lst_inbox") === "lst_inbox");
  const selectedList = snapshot.taskView.kind === "list" ? snapshot.taskView.listID : undefined;
  const listTasks = open.filter((task) => task.listID === selectedList);
  const completed = snapshot.tasks.filter((task) => task.status === "done");
  const monthTasks = open.filter((task) => taskSchedule(task) && sameMonth(new Date(taskSchedule(task)!), month));
  const calendarTasks = calendarDay ? monthTasks.filter((task) => dateKey(new Date(taskSchedule(task)!)) === dateKey(calendarDay)) : monthTasks;
  const currentList = snapshot.taskLists.find((list) => list.id === selectedList);
  const view = snapshot.taskView.kind;
  const pageTitle = view === "today" ? "Today" : view === "inbox" ? "Inbox" : view === "calendar" ? "Calendar" : currentList?.name ?? "Tasks";
  const visibleTasks = view === "today" ? todayTasks : view === "inbox" ? inbox : view === "upcoming" ? upcoming : view === "completed" ? completed : view === "list" ? listTasks : [];
  const upcomingGroups = [...new Set(upcoming.map((task) => dateKey(new Date(taskSchedule(task)!))))].sort().map((key) => ({
    key,
    tasks: upcoming.filter((task) => dateKey(new Date(taskSchedule(task)!)) === key),
  }));

  const openActivity = (task: TaskInfo) => {
    setActivityTask(task);
    model.requestTaskActivity(task.id);
  };

  const calendarCells = useMemo(() => {
    const firstDay = new Date(month.getFullYear(), month.getMonth(), 1);
    const start = new Date(firstDay);
    start.setDate(1 - firstDay.getDay());
    return Array.from({ length: 42 }, (_, index) => {
      const date = new Date(start);
      date.setDate(start.getDate() + index);
      return date;
    });
  }, [month]);

  return (
    <main className="tasks-page">
      <div className="tasks-content">
        <header className="tasks-page-header">
          <div className="tasks-heading-copy">
            <h1>{pageTitle}</h1>
            {view === "today" ? <p>{today.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</p> : null}
          </div>
          <div className="tasks-header-actions">
            <button type="button" className="icon-btn tasks-refresh" aria-label="Refresh tasks" title="Refresh tasks" onClick={() => model.refreshTasks()}><RefreshCw size={15} /></button>
            {view !== "calendar" ? <button type="button" className="btn primary" onClick={() => setCreatingFor(null)}><Plus size={15} /> Add task</button> : null}
          </div>
        </header>

        {view === "calendar" ? (
          <section className="task-calendar">
            <div className="calendar-toolbar">
              <button className="icon-btn" aria-label="Previous month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}><ChevronLeft size={18} /></button>
              <h2>{month.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</h2>
              <button className="icon-btn" aria-label="Next month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}><ChevronRight size={18} /></button>
              <button className="btn small" onClick={() => { setMonth(new Date(today.getFullYear(), today.getMonth(), 1)); setCalendarDay(today); }}>Today</button>
            </div>
            <div className="calendar-grid">
              {"Sun Mon Tue Wed Thu Fri Sat".split(" ").map((name) => <div className="calendar-weekday" key={name}>{name}</div>)}
              {calendarCells.map((date) => {
                const dayTasks = monthTasks.filter((task) => dateKey(new Date(taskSchedule(task)!)) === dateKey(date));
                const selected = calendarDay && dateKey(calendarDay) === dateKey(date);
                return <button key={dateKey(date)} className={`calendar-day${sameMonth(date, month) ? "" : " outside"}${selected ? " selected" : ""}${dateKey(date) === dateKey(today) ? " today" : ""}`} onClick={() => setCalendarDay(date)}>
                  <span>{date.getDate()}</span>{dayTasks.length > 0 ? <i>{dayTasks.length}</i> : null}
                </button>;
              })}
            </div>
            <div className="calendar-day-tasks">
              <div className="tasks-group-heading"><h2>{calendarDay ? calendarDay.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }) : "Tasks this month"}</h2><span>{calendarTasks.length}</span></div>
              {calendarTasks.length ? <TaskList tasks={calendarTasks} onActivity={openActivity} onSubtask={(task) => setCreatingFor(task.id)} onOpenDetail={setDetailTask} /> : <div className="tasks-empty-inline">No tasks scheduled for this date.</div>}
            </div>
          </section>
        ) : (
          <>
            <div className="tasks-overview"><span>{visibleTasks.length} {view === "completed" ? "completed" : "open"}</span></div>
            {visibleTasks.length === 0 ? (
              <div className="tasks-empty"><div className="tasks-empty-mark"><Check size={23} /></div><h2>{view === "today" ? "No tasks today" : view === "completed" ? "Nothing completed yet" : view === "upcoming" ? "Nothing scheduled" : "This list is empty"}</h2><p>{view === "completed" ? "Finished tasks will collect here." : "Add a task here or ask an agent to keep track of it."}</p>{view !== "completed" ? <button type="button" className="btn primary" onClick={() => setCreatingFor(null)}><Plus size={15} /> Add task</button> : null}</div>
            ) : view === "today" ? <>
              {overdueTasks.length ? <TaskSection title="Overdue" tasks={overdueTasks} onActivity={openActivity} onSubtask={(task) => setCreatingFor(task.id)} onOpenDetail={setDetailTask} /> : null}
              {dueTodayTasks.length ? <TaskSection title="Today" tasks={dueTodayTasks} onActivity={openActivity} onSubtask={(task) => setCreatingFor(task.id)} onOpenDetail={setDetailTask} /> : null}
            </> : view === "upcoming" ? upcomingGroups.map((group) => <TaskSection key={group.key} title={format.dayTitle(new Date(`${group.key}T12:00:00`))} tasks={group.tasks} onActivity={openActivity} onSubtask={(task) => setCreatingFor(task.id)} onOpenDetail={setDetailTask} />)
              : <TaskList tasks={visibleTasks} completed={view === "completed"} onActivity={openActivity} onSubtask={(task) => setCreatingFor(task.id)} onOpenDetail={setDetailTask} />}
          </>
        )}
      </div>
      <button type="button" className="tasks-fab" aria-label="Create task" title="Create task" onClick={() => setCreatingFor(null)}><Plus size={22} /></button>
      {creatingFor !== undefined ? <TaskComposer parentTaskID={creatingFor} onClose={() => setCreatingFor(undefined)} /> : null}
      {activityTask ? <ActivitySheet task={activityTask} onClose={() => setActivityTask(null)} /> : null}
      {detailTask ? <TaskDetailSheet task={detailTask} onClose={() => setDetailTask(null)} onActivity={() => { setDetailTask(null); openActivity(detailTask); }} onSubtask={() => { setCreatingFor(detailTask.id); setDetailTask(null); }} /> : null}
    </main>
  );
}

function TaskList({ tasks, completed = false, onActivity, onSubtask, onOpenDetail }: { tasks: TaskInfo[]; completed?: boolean; onActivity: (task: TaskInfo) => void; onSubtask: (task: TaskInfo) => void; onOpenDetail: (task: TaskInfo) => void }) {
  const model = useAppModel();
  return <div className="task-tree">{tasks.map((task) => (
    <div className="task-tree-row" key={task.id}>
      <TaskCard task={task} completed={completed} onActivity={onActivity} onSubtask={onSubtask} onOpenDetail={onOpenDetail} />
    </div>
  ))}</div>;
}

function TaskSection({ title, tasks, onActivity, onSubtask, onOpenDetail }: { title: string; tasks: TaskInfo[]; onActivity: (task: TaskInfo) => void; onSubtask: (task: TaskInfo) => void; onOpenDetail: (task: TaskInfo) => void }) {
  return <section className="tasks-group"><div className="tasks-group-heading"><h2>{title}</h2><span>{tasks.length}</span></div><TaskList tasks={tasks} onActivity={onActivity} onSubtask={onSubtask} onOpenDetail={onOpenDetail} /></section>;
}

function TaskCard({ task, completed, onActivity, onSubtask, onOpenDetail }: { task: TaskInfo; completed: boolean; onActivity: (task: TaskInfo) => void; onSubtask: (task: TaskInfo) => void; onOpenDetail: (task: TaskInfo) => void }) {
  const model = useAppModel();
  const snapshot = useAppSnapshot();
  const schedule = taskSchedule(task);
  const due = schedule ? format.parseISO(schedule) : null;
  const list = snapshot.taskLists.find((item) => item.id === task.listID);
  return <article className={`dashboard-task${completed ? " completed" : ""}`}>
    <button type="button" className="dashboard-task-check" aria-label={completed ? `Reopen ${task.title}` : `Complete ${task.title}`} onClick={() => model.updateTask(task, completed ? "reopen" : "done")}><Check size={13} /></button>
    <div className="dashboard-task-copy">
      <button type="button" className="dashboard-task-title task-title-button" onClick={() => onOpenDetail(task)}>{task.title}</button>
      {task.description ? <div className="dashboard-task-description">{task.description}</div> : null}
      {task.progressNote ? <div className="dashboard-task-progress"><span className="task-progress-pulse" />{task.progressNote}</div> : null}
      <div className="dashboard-task-meta">{due ? <span className={dateKey(due) < dateKey(new Date()) ? "overdue" : ""}>{format.stamp(due)}</span> : null}{task.deadlineAt ? <><span className="task-meta-separator">·</span><span>Deadline {format.stamp(format.parseISO(task.deadlineAt) ?? new Date(task.deadlineAt))}</span></> : null}{task.reminderAt ? <><span className="task-meta-separator">·</span><span>Reminder {format.stamp(format.parseISO(task.reminderAt) ?? new Date(task.reminderAt))}</span></> : null}{list && list.id !== "lst_inbox" ? <><span className="task-meta-separator">·</span><span>{list.name}</span></> : null}<><span className="task-meta-separator">·</span><span className={`task-priority-label ${task.priority}`}>{priorityLabel(task.priority)}</span></><span className={`task-workflow-label ${task.workflowStatus ?? "not_started"}`}>{workflowLabel(task.workflowStatus)}</span>{task.labels?.map((label) => <span className="task-label-chip" key={label}>#{label}</span>)}{task.repeatRule && task.repeatRule !== "none" ? <><span className="task-meta-separator">·</span><span>Repeats {task.repeatRule}</span></> : null}{task.ownerAgentId ? <><span className="task-meta-separator">·</span><span>{task.ownerAgentId}</span></> : null}{task.attachments?.map((file) => <button key={file.id} type="button" className="task-attachment-pill" title={`Download ${file.name}`} onClick={async () => {
          try {
            const blob = await model.attachmentBlob(file.id);
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = file.name;
            anchor.click();
            setTimeout(() => URL.revokeObjectURL(url), 30_000);
          } catch { /* Keep task view usable if a file was removed. */ }
        }}><Paperclip size={11} />{file.name}</button>)}</div>
    </div>
    {!completed ? <details className="task-action-menu">
      <summary aria-label={`More actions for ${task.title}`} title="More task actions"><MoreHorizontal size={16} /></summary>
      <div className="task-action-popover">
        <button type="button" className="task-action-option" onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); onSubtask(task); }}><Plus size={14} /> Add subtask</button>
        <button type="button" className="task-action-option" onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); onActivity(task); }}><Activity size={14} /> View activity</button>
        <div className="task-action-divider" />
        <button type="button" className="task-action-option" onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); model.updateTask(task,"snooze",new Date(Date.now()+3_600_000)); }}>Snooze 1 hour</button>
        <button type="button" className="task-action-option" onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); const tomorrow=new Date();tomorrow.setDate(tomorrow.getDate()+1);tomorrow.setHours(9,0,0,0);model.updateTask(task,"snooze",tomorrow); }}>Snooze until tomorrow</button>
      </div>
    </details> : null}
  </article>;
}

function TaskComposer({ parentTaskID, onClose }: { parentTaskID: string | null; onClose: () => void }) {
  const model = useAppModel();
  const snapshot = useAppSnapshot();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [due, setDue] = useState("");
  const [reminder, setReminder] = useState("");
  const parentTask = parentTaskID ? snapshot.tasks.find((task) => task.id === parentTaskID) : undefined;
  const [listID, setListID] = useState(parentTask?.listID ?? (snapshot.taskView.kind === "list" ? snapshot.taskView.listID ?? "lst_inbox" : "lst_inbox"));
  const [priority, setPriority] = useState<"low" | "normal" | "high" | "urgent">("normal");
  const [repeatRule, setRepeatRule] = useState<"none" | "daily" | "weekly" | "monthly">("none");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [voiceOn, setVoiceOn] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordingStreamRef = useRef<MediaStream | null>(null);
  const recordingChunksRef = useRef<Blob[]>([]);
  type Recognition = { lang: string; continuous: boolean; interimResults: boolean; onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>>; resultIndex?: number }) => void) | null; onend: (() => void) | null; start: () => void; stop: () => void };
  const recognitionRef = useRef<Recognition | null>(null);
  useEffect(() => () => {
    recognitionRef.current?.stop();
    recorderRef.current?.stop();
    recordingStreamRef.current?.getTracks().forEach((track) => track.stop());
  }, []);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (!title.trim()) return;
    setBusy(true); setError(null);
    try {
      const uploaded = [];
      for (const file of files.slice(0, 5)) uploaded.push(await model.uploadTaskAttachment(file));
      const dueAt = due ? new Date(due) : undefined;
      const reminderAt = reminder ? new Date(reminder) : repeatRule !== "none" ? dueAt : undefined;
      model.createTask({ title, description, dueAt, reminderAt, repeatRule, priority, listID, parentTaskID: parentTaskID ?? undefined, attachmentIDs: uploaded.map((file) => file.id) });
      onClose();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Task could not be created."); }
    finally { setBusy(false); }
  };
  const recordVoice = async () => {
    if (recorderRef.current) {
      recorderRef.current.stop();
      recognitionRef.current?.stop();
      recognitionRef.current = null;
      setVoiceOn(false);
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError("Audio recording is not available in this browser.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      recordingStreamRef.current = stream;
      recordingChunksRef.current = [];
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => { if (event.data.size) recordingChunksRef.current.push(event.data); };
      recorder.onstop = () => {
        const blob = new Blob(recordingChunksRef.current, { type: recorder.mimeType || "audio/webm" });
        if (blob.size) setFiles((old) => [...old, new File([blob], `voice-note-${Date.now()}.webm`, { type: blob.type })]);
        recordingStreamRef.current?.getTracks().forEach((track) => track.stop());
        recordingStreamRef.current = null;
        recorderRef.current = null;
      };
      recorder.start();
      setVoiceOn(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Microphone access was not available.");
      return;
    }
    const api = window as Window & { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
    const Speech = api.SpeechRecognition ?? api.webkitSpeechRecognition;
    if (!Speech) return;
    const recognition = new Speech(); recognitionRef.current = recognition; recognition.lang = navigator.language; recognition.continuous = true; recognition.interimResults = false;
    recognition.onresult = (event) => { const text = Array.from(event.results).slice(event.resultIndex ?? 0).map((result) => result[0]?.transcript ?? "").join(" "); if (text) setDescription((previous) => `${previous}${previous ? "\n" : ""}${text}`); };
    recognition.onend = () => { recognitionRef.current = null; };
    recognition.start();
  };
  return <div className="task-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <form className="task-composer" onSubmit={(event) => void submit(event)}>
      <div className="task-composer-heading"><h2>{parentTaskID ? "Add subtask" : "New task"}</h2><button type="button" className="icon-btn" aria-label="Close" onClick={onClose}><X size={18} /></button></div>
      <input autoFocus className="text-input task-composer-title" placeholder="What needs to get done?" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={500} />
      <textarea className="text-area" placeholder="Add notes or dictate a voice note…" value={description} onChange={(event) => setDescription(event.target.value)} rows={3} />
      <div className="task-composer-fields">
        <label>Collection<select className="select" value={listID} onChange={(event) => setListID(event.target.value)}>{snapshot.taskLists.map((list) => <option value={list.id} key={list.id}>{list.id === "lst_inbox" ? "Inbox · No collection" : list.name}</option>)}</select></label>
        <label>Due date<input className="text-input" type="datetime-local" value={due} onChange={(event) => setDue(event.target.value)} /></label>
        <label>Reminder<input className="text-input" type="datetime-local" value={reminder} onChange={(event) => setReminder(event.target.value)} /></label>
        <label>Repeat<select className="select" value={repeatRule} onChange={(event) => setRepeatRule(event.target.value as typeof repeatRule)}><option value="none">Never</option><option value="daily">Every day</option><option value="weekly">Every week</option><option value="monthly">Every month</option></select></label>
        <label>Priority<select className="select" value={priority} onChange={(event) => setPriority(event.target.value as typeof priority)}><option value="urgent">P0 · Urgent</option><option value="high">P1 · High</option><option value="normal">P2 · Medium</option><option value="low">P3 · Low</option></select></label>
      </div>
      <div className="task-composer-attachments"><label className="btn small"><Paperclip size={14} /> Attach files<input type="file" multiple hidden onChange={(event) => setFiles((old) => [...old, ...Array.from(event.target.files ?? [])])} /></label><label className="btn small"><Paperclip size={14} /> Attach folder<input type="file" multiple hidden {...({ webkitdirectory: "" } as Record<string, string>)} onChange={(event) => setFiles((old) => [...old, ...Array.from(event.target.files ?? [])])} /></label><button type="button" className={`btn small${voiceOn ? " active" : ""}`} onClick={recordVoice}><Mic size={14} /> {voiceOn ? "Stop dictation" : "Voice note"}</button>{files.length ? <span>{files.length} file(s) selected</span> : null}</div>
      {error ? <div className="warning-text">{error}</div> : null}
      <div className="task-composer-footer"><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="submit" className="btn primary" disabled={busy || !title.trim()}>{busy ? "Saving…" : "Create task"}</button></div>
    </form>
  </div>;
}

function ActivitySheet({ task, onClose }: { task: TaskInfo; onClose: () => void }) {
  const snapshot = useAppSnapshot();
  const entries = snapshot.taskActivity?.taskID === task.id ? snapshot.taskActivity.entries : [];
  return <div className="task-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="task-activity-sheet"><div className="task-composer-heading"><h2>Task activity</h2><button type="button" className="icon-btn" aria-label="Close activity" onClick={onClose}><X size={18} /></button></div><p className="task-activity-title">{task.title}</p>{entries.length ? entries.map((entry) => <div className="task-activity-entry" key={entry.id}><span><strong>{entry.actor}</strong> {entry.action}{entry.detail ? ` · ${entry.detail}` : ""}</span><time>{format.stamp(format.parseISO(entry.createdAt) ?? new Date())}</time></div>) : <div className="tasks-empty-inline">No activity recorded yet.</div>}</section></div>;
}

function TaskDetailSheet({ task, onClose, onActivity, onSubtask }: { task: TaskInfo; onClose: () => void; onActivity: () => void; onSubtask: () => void }) {
  const model = useAppModel();
  const snapshot = useAppSnapshot();
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description ?? "");
  const [progressNote, setProgressNote] = useState(task.progressNote ?? "");
  const [listID, setListID] = useState(task.listID ?? "lst_inbox");
  const [priority, setPriority] = useState<TaskInfo["priority"]>(task.priority);
  const [workflowStatus, setWorkflowStatus] = useState<TaskInfo["workflowStatus"]>(task.workflowStatus ?? "not_started");
  const [handoffAgentID, setHandoffAgentID] = useState(snapshot.conversation.agentID);
  const [due, setDue] = useState(dateInput(task.dueAt));
  const [deadline, setDeadline] = useState(dateInput(task.deadlineAt));
  const [reminder, setReminder] = useState(dateInput(task.reminderAt));
  const [labels, setLabels] = useState((task.labels ?? []).join(", "));
  const children = snapshot.tasks.filter((item) => item.parentTaskID === task.id);
  const save = () => {
    const date = (value: string) => value ? new Date(value) : null;
    model.editTask(task, { title, description: description || null, listID, priority, workflowStatus, progressNote: progressNote || null, dueAt: date(due), deadlineAt: date(deadline), reminderAt: date(reminder), labels: labels.split(",").map((label) => label.trim().replace(/^#/, "")).filter(Boolean) });
    onClose();
  };
  const listName = snapshot.taskLists.find((list) => list.id === listID)?.name ?? "Inbox";
  return <div className="task-detail-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="task-detail-sheet" aria-label={`Details for ${task.title}`}>
      <header className="task-detail-header"><span className="task-detail-project">{listID === "lst_inbox" ? "Inbox · No collection" : listName}</span><div><button type="button" className="btn small" onClick={onActivity}><Activity size={14} /> Activity</button><button type="button" className="icon-btn" aria-label="Close details" onClick={onClose}><X size={18} /></button></div></header>
      <div className="task-detail-body">
        <label className="task-detail-field"><span>Task</span><input className="text-input task-detail-title" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={500} /></label>
        <label className="task-detail-field"><span>Description</span><textarea className="text-area" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Add notes, context, or a voice note…" rows={3} /></label>
        <label className="task-detail-field"><span>Current AI progress</span><textarea className="text-area" value={progressNote} onChange={(event) => setProgressNote(event.target.value)} placeholder="What is happening with this task right now?" rows={2} maxLength={1000} /></label>
        <section className="task-detail-subtasks"><div className="task-detail-section-heading"><h3>Subtasks</h3><button type="button" className="btn small" onClick={onSubtask}><Plus size={14} /> Add subtask</button></div>
          {children.length ? children.map((child) => <div className="task-detail-child" key={child.id}><button type="button" className={`dashboard-task-check${child.status === "done" ? " checked" : ""}`} aria-label={child.status === "done" ? `Reopen ${child.title}` : `Complete ${child.title}`} onClick={() => model.updateTask(child, child.status === "done" ? "reopen" : "done")}><Check size={13} /></button><span>{child.title}</span></div>) : <p className="task-detail-hint">Break this task into smaller steps.</p>}
        </section>
        <section className="task-detail-properties">
          <label><span>Task status</span><select className="select" value={workflowStatus} onChange={(event) => setWorkflowStatus(event.target.value as NonNullable<TaskInfo["workflowStatus"]>)}><option value="not_started">Not started</option><option value="in_progress">In progress</option><option value="ai_review">AI review</option></select></label>
          <label><span>Collection</span><select className="select" value={listID} onChange={(event) => setListID(event.target.value)}><option value="lst_inbox">Inbox · No collection</option>{snapshot.taskLists.filter((list) => list.id !== "lst_inbox").map((list) => <option value={list.id} key={list.id}>{list.name}</option>)}</select></label>
          <label><span>Due date</span><input className="text-input" type="datetime-local" value={due} onChange={(event) => setDue(event.target.value)} /></label>
          <label><span>Deadline</span><input className="text-input" type="datetime-local" value={deadline} onChange={(event) => setDeadline(event.target.value)} /></label>
          <label><span>Priority</span><select className="select" value={priority} onChange={(event) => setPriority(event.target.value as TaskInfo["priority"])}><option value="urgent">P0 · Urgent</option><option value="high">P1 · High</option><option value="normal">P2 · Medium</option><option value="low">P3 · Low</option></select></label>
          <label><span>Labels</span><input className="text-input" value={labels} onChange={(event) => setLabels(event.target.value)} placeholder="Add labels, separated by commas" /><small className="task-detail-hint">Separate labels with commas.</small></label>
          <label><span>Reminder</span><input className="text-input" type="datetime-local" value={reminder} onChange={(event) => setReminder(event.target.value)} /></label>
          <label><span>AI agent</span><select className="select" value={handoffAgentID} onChange={(event) => setHandoffAgentID(event.target.value)}>{snapshot.agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label>
        </section>
        <div className="task-detail-footer"><span>Created {format.stamp(format.parseISO(task.createdAt) ?? new Date())}</span><div><button type="button" className="btn" disabled={!handoffAgentID} onClick={() => { const agent = snapshot.agents.find((item) => item.id === handoffAgentID); if (agent) { model.handoffTask(task, agent); onClose(); } }}>Hand off to AI</button><button type="button" className="btn primary" disabled={!title.trim()} onClick={save}>Save changes</button></div></div>
      </div>
    </section>
  </div>;
}

function dateInput(value?: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function priorityLabel(priority: TaskInfo["priority"]): string { return ({ urgent: "P0", high: "P1", normal: "P2", low: "P3" })[priority]; }
function workflowLabel(status?: TaskInfo["workflowStatus"]): string { return ({ not_started: "Not started", in_progress: "In progress", ai_review: "AI review" })[status ?? "not_started"]; }

function dateKey(date: Date): string { return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`; }
function sameMonth(date: Date, month: Date): boolean { return date.getFullYear() === month.getFullYear() && date.getMonth() === month.getMonth(); }
function taskSchedule(task: TaskInfo): string | null { return task.dueAt ?? task.reminderAt ?? null; }
