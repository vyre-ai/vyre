// @ts-check
// diagnose: why there is no extension connected, and the one thing to do, from what has actually reached the socket.
// Pure, so the module (chrome.status, every no_extension error), the install command's live check and `doctor` all say the same thing.

/**
 * @param {{ connected: boolean, listenError?: string|null, hostRegistered?: boolean, stats?: { connections: number, hellos: number, refused: { why: string }|null } }} s
 * @returns {{ stage: string, problem: string, fix: string }|null} null while connected
 */
export function diagnoseConnection(s) {
  if (s.connected) return null;
  if (s.listenError) return { stage: "not_listening", problem: "this session is not the one connected to Chrome", fix: `Another Vyre for Chrome session already holds the connector (${s.listenError}). Use that session, or close it and restart this one.` };
  if (s.hostRegistered === false) return { stage: "host_not_registered", problem: "the connector is not registered with any browser", fix: "Run `vyre-chrome install` in a terminal, then load the extension and (if Chrome was already open) quit and reopen Chrome." };
  const st = s.stats || { connections: 0, hellos: 0, refused: null };
  if (st.refused) return { stage: "host_refused", problem: `a connector started but was refused: ${st.refused.why}`, fix: "Run `vyre-chrome install` again (it re-registers the connector for the right extension id), reload the extension in chrome://extensions, and run `vyre-chrome doctor` if it still fails." };
  if (st.hellos > 0) return { stage: "extension_dropped", problem: "the extension was connected and then disconnected (Chrome or the extension restarted, or the connector stopped)", fix: "It reconnects by itself within seconds. If it does not, click the Vyre for Chrome icon in Chrome's toolbar to see why, or run `vyre-chrome doctor`." };
  if (st.connections > 0) return { stage: "host_no_hello", problem: "a connector process started but the extension never said hello", fix: "Reload the extension in chrome://extensions (it may be an old copy), then run `vyre-chrome doctor` if it still fails." };
  return { stage: "host_never_started", problem: "Chrome has not started the connector: no connector process has ever connected", fix: "In Chrome open chrome://extensions and check that Vyre for Chrome is loaded (Load unpacked) and enabled, and click its toolbar icon to see why it cannot connect. If it is loaded and enabled, quit and reopen Chrome once: Chrome may only pick up a newly installed connector when it starts. `vyre-chrome doctor` checks the rest." };
}
