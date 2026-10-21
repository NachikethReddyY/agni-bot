import { spawn, spawnSync } from "node:child_process";

/**
 * Read a secret from the terminal without echoing it.
 *
 * Echo is turned off *before* the prompt is printed, so even an immediate
 * paste cannot appear on screen. A child shell then reads one line from the
 * same TTY and returns it over a pipe — never argv, never the terminal. The
 * parent restores echo in a finally block, including on Ctrl-C or spawn
 * failure. If echo cannot be disabled, it refuses rather than reading in the
 * clear.
 *
 * The caller must pause its readline interface so it does not race the child
 * for the same bytes. Over SSH this reads the SSH pty directly; a non-TTY
 * (piped input) refuses rather than pretending to be secure.
 */
export async function readSecret(promptText: string): Promise<string> {
  if (process.stdin.isTTY !== true) {
    throw new Error("secure input needs a TTY — use the web app when piping input");
  }
  process.stdin.pause();
  const setEcho = (on: boolean): boolean => {
    try {
      const result = spawnSync("/bin/sh", ["-c", `stty ${on ? "echo" : "-echo"}`], {
        stdio: ["inherit", "ignore", "ignore"],
      });
      return result.status === 0;
    } catch {
      return false;
    }
  };
  if (!setEcho(false)) throw new Error("cannot disable terminal echo; use the web app");
  process.stdout.write(promptText);
  try {
    const child = spawn(
      "/bin/sh",
      ["-c", "IFS= read -r value; printf '%s' \"$value\""],
      { stdio: ["inherit", "pipe", "inherit"] },
    );
    child.stdout.setEncoding("utf8");
    let value = "";
    child.stdout.on("data", (chunk: string) => {
      value += chunk;
    });
    const code = await new Promise<number>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (exitCode) => resolve(exitCode ?? 1));
    });
    if (code !== 0) throw new Error("cancelled");
    return value;
  } finally {
    process.stdout.write("\n");
    setEcho(true);
  }
}
