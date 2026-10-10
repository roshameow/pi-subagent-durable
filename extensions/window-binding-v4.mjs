// @pi_session is shared window state: exact path alone is insufficient when
// another process resumes the same session. Pair it with an unguessable owner.
// RMUX window IDs are @digits. $digits identify SESSIONS, never windows.
export const isRmuxWindowId = id => typeof id === "string" && /^@\d+$/.test(id);
const literal = value => value.replace(/#/g, "##").replace(/,/g, "#,").replace(/}/g, "#}");
export async function registerWindowBinding(command, binding) {
  if (!isRmuxWindowId(binding.windowId) || !/^[a-f0-9-]{36}$/.test(binding.ownerToken)) throw new Error("unsafe window binding");
  // One daemon command sequence; replacement writers always update both keys.
  const r = await command("set-option", "-w", "-t", binding.windowId, "@pi_session", binding.sessionPath,
    ";", "set-option", "-w", "-t", binding.windowId, "@pi_session_owner", binding.ownerToken);
  if (r.returnCode !== 0) throw new Error("window binding registration failed");
}
export async function clearWindowBinding(command, binding) {
  if (!isRmuxWindowId(binding.windowId) || !/^[a-f0-9-]{36}$/.test(binding.ownerToken)) return false;
  const r = await command("display-message", "-p", "-t", binding.windowId, "#{@pi_session}|#{@pi_session_owner}");
  if (r.returnCode !== 0) return false;
  if (String(r.stdout || "").trim() !== `${binding.sessionPath}|${binding.ownerToken}`) return true; // no longer ours
  const predicate = `#{&&:#{==:#{@pi_session},${literal(binding.sessionPath)}},#{==:#{@pi_session_owner},${binding.ownerToken}}}`;
  const cleared = await command("if-shell", "-F", "-t", binding.windowId, predicate,
    `set-option -w -u -t ${binding.windowId} @pi_session ; set-option -w -u -t ${binding.windowId} @pi_session_owner`);
  if (cleared.returnCode !== 0) return false;
  return true; // mutation-time compare means a new owner's value is untouched
}
